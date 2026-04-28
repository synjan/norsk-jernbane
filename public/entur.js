// Entur JourneyPlanner GraphQL-klient.
// Eksponerer window.Entur = { findStopPlace, fetchDepartures, fetchSituations,
//                              fetchVehicles }.
// Ingen auth — kun ET-Client-Name-header.

(function () {
  const ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
  const VEHICLES_ENDPOINT = "https://api.entur.io/realtime/v2/vehicles/graphql";
  const CLIENT_NAME = "janarne84-norsk-jernbane";
  const STOP_CACHE_PREFIX = "entur:stop:";
  const STOP_CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 dager
  const SITUATION_CACHE_PREFIX = "entur:sit:";
  const SITUATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutter — avvik er ferskvare

  // Bbox-radius for stedssøk: ~150 m i hver retning ved norske breddegrader.
  // Lengdegrader krymper med cos(lat); 0.0028 ≈ 150 m ved 60°N.
  const BBOX_DLAT = 0.0014;
  const BBOX_DLON = 0.0028;

  async function graphql(query, variables, signal) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ET-Client-Name": CLIENT_NAME,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Entur HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`Entur: ${payload.errors[0].message}`);
    }
    return payload.data;
  }

  function cacheKey(lat, lng) {
    return `${STOP_CACHE_PREFIX}${lat.toFixed(4)},${lng.toFixed(4)}`;
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.expires < Date.now()) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed.value;
    } catch {
      return null;
    }
  }

  function writeCache(key, value, ttlMs = STOP_CACHE_TTL_MS) {
    try {
      localStorage.setItem(key, JSON.stringify({
        value,
        expires: Date.now() + ttlMs,
      }));
    } catch {
      // localStorage kan være deaktivert eller full — ignorer.
    }
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const STOP_BY_BBOX_QUERY = `
    query stopByBbox(
      $minLat: Float!, $maxLat: Float!,
      $minLon: Float!, $maxLon: Float!
    ) {
      stopPlacesByBbox(
        minimumLatitude: $minLat, maximumLatitude: $maxLat,
        minimumLongitude: $minLon, maximumLongitude: $maxLon
      ) {
        id name transportMode latitude longitude
      }
    }
  `;

  const DEPARTURES_QUERY = `
    query departures($id: String!, $n: Int!) {
      stopPlace(id: $id) {
        name
        estimatedCalls(numberOfDepartures: $n, timeRange: 7200) {
          expectedDepartureTime
          aimedDepartureTime
          realtime
          forBoarding
          destinationDisplay { frontText }
          quay { publicCode }
          serviceJourney {
            line { publicCode name transportMode }
          }
        }
      }
    }
  `;

  // Returnerer { id, name } for nærmeste tog-stoppested innen ~150 m, eller null.
  async function findStopPlace(lat, lng, signal) {
    const key = cacheKey(lat, lng);
    const cached = readCache(key);
    if (cached !== null) return cached;

    const data = await graphql(STOP_BY_BBOX_QUERY, {
      minLat: lat - BBOX_DLAT, maxLat: lat + BBOX_DLAT,
      minLon: lng - BBOX_DLON, maxLon: lng + BBOX_DLON,
    }, signal);

    const all = data?.stopPlacesByBbox || [];
    const railStops = all.filter((s) =>
      Array.isArray(s.transportMode) && s.transportMode.includes("rail")
    );
    railStops.sort((a, b) =>
      distanceMeters(lat, lng, a.latitude, a.longitude)
      - distanceMeters(lat, lng, b.latitude, b.longitude)
    );

    const result = railStops.length
      ? { id: railStops[0].id, name: railStops[0].name }
      : null;

    // Cache også null-svar (kortere TTL hadde vært enda bedre, men 30 dager
    // er OK for hobbyprosjekt — museumsbaner endrer seg sjelden).
    writeCache(key, result);
    return result;
  }

  // Returnerer liste av togavganger for et NSR-stoppested.
  async function fetchDepartures(nsrId, n = 5, signal) {
    const data = await graphql(DEPARTURES_QUERY, { id: nsrId, n }, signal);
    if (!data?.stopPlace) return [];
    return (data.stopPlace.estimatedCalls || [])
      .filter((c) => c.serviceJourney?.line?.transportMode === "rail")
      .filter((c) => c.forBoarding);
  }

  // SIRI-SX-avvik for et stoppested. summary/description er flerspråklige
  // arrays — vi plukker norsk først, deretter engelsk, deretter første tilgjengelige.
  const SITUATIONS_QUERY = `
    query situations($id: String!) {
      stopPlace(id: $id) {
        situations {
          summary { value language }
          description { value language }
          advice { value language }
          validityPeriod { startTime endTime }
          severity
          reportType
        }
      }
    }
  `;

  function pickText(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const byLang = (lang) => items.find((t) => t?.language === lang)?.value;
    return byLang("no") || byLang("nb") || byLang("nn") || byLang("en") || items[0]?.value || "";
  }

  function isActive(period, now) {
    if (!period) return true;
    const start = period.startTime ? Date.parse(period.startTime) : null;
    const end = period.endTime ? Date.parse(period.endTime) : null;
    if (start && now < start) return false;
    if (end && now > end) return false;
    return true;
  }

  // Returnerer normalisert liste av aktive avvik. Tom liste hvis ingen.
  // Cacher per NSR-ID i 5 minutter for å skåne API-et ved popup-spam.
  async function fetchSituations(nsrId, signal) {
    const key = `${SITUATION_CACHE_PREFIX}${nsrId}`;
    const cached = readCache(key);
    if (cached !== null) return cached;

    const data = await graphql(SITUATIONS_QUERY, { id: nsrId }, signal);
    const raw = data?.stopPlace?.situations || [];
    const now = Date.now();
    const result = raw
      .filter((s) => isActive(s.validityPeriod, now))
      .map((s) => ({
        summary: pickText(s.summary),
        description: pickText(s.description),
        advice: pickText(s.advice),
        severity: s.severity || "unknown",
        reportType: s.reportType || "general",
      }))
      .filter((s) => s.summary || s.description);

    writeCache(key, result, SITUATION_CACHE_TTL_MS);
    return result;
  }

  // Live togposisjoner (sanntid, oppdateres ofte). Bruker Entur sitt
  // dedikerte vehicles-GraphQL — separat endepunkt fra JourneyPlanner.
  // Ingen caching her, hver call gir fersk data.
  const VEHICLES_QUERY = `
    query vehicles {
      vehicles(mode: RAIL) {
        line { publicCode lineName }
        location { latitude longitude }
        direction
        bearing
        speed
        delay
        monitored
        lastUpdated
        expiration
        vehicleId
        originName
        destinationName
        operator { operatorRef }
        serviceJourney { id }
        datedServiceJourney { id }
      }
    }
  `;

  async function fetchVehicles(signal) {
    const response = await fetch(VEHICLES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ET-Client-Name": CLIENT_NAME,
      },
      body: JSON.stringify({ query: VEHICLES_QUERY }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Entur Vehicles HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`Entur Vehicles: ${payload.errors[0].message}`);
    }
    return payload.data?.vehicles || [];
  }

  // Plukk én vehicle ut fra fersk vehicles-respons. API-et har ikke en
  // single-vehicle-query, så vi henter alle og filtrerer på klient.
  async function findVehicle(datedJourneyId, signal) {
    const all = await fetchVehicles(signal);
    return all.find((v) => v.datedServiceJourney?.id === datedJourneyId) || null;
  }

  window.Entur = {
    findStopPlace,
    fetchDepartures,
    fetchSituations,
    fetchVehicles,
    findVehicle,
    distanceMeters,
  };
})();
