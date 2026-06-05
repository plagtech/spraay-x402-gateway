/**
 * ═══════════════════════════════════════════════════════════════
 * 💧 Spraay Gateway — Geospatial & Spatial Intelligence Handlers
 * ═══════════════════════════════════════════════════════════════
 *
 * Individual handler functions matching the gateway pattern.
 * Each handler is exported and registered via app.post() in index.ts.
 *
 * Providers (all free tier at launch):
 *   Nominatim (OSM)       — geocoding, reverse, nearby, timezone
 *   OSRM                  — routing/directions
 *   OpenRouteService      — isochrone, distance matrix
 *   Open Topo Data        — elevation
 *   OpenWeatherMap        — weather, alerts
 *   AeroDataBox (RapidAPI) — flight status, airport info ($0.99/mo)
 *
 * Env vars:
 *   NOMINATIM_URL, OSRM_URL, OPEN_TOPO_URL
 *   ORS_API_KEY, OPENWEATHER_API_KEY, AERODATABOX_RAPIDAPI_KEY
 */

import { Request, Response } from "express";

// ─── Provider URLs (swap to self-hosted when volume demands it) ───
const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const OSRM = process.env.OSRM_URL || "https://router.project-osrm.org";
const ORS = "https://api.openrouteservice.org";
const ORS_KEY = process.env.ORS_API_KEY || "";
const OWM = "https://api.openweathermap.org/data/2.5";
const OWM_KEY = process.env.OPENWEATHER_API_KEY || "";
const AERO_BASE = "https://aerodatabox.p.rapidapi.com";
const AERO_KEY = process.env.AERODATABOX_RAPIDAPI_KEY || "";
const AERO_HOST = "aerodatabox.p.rapidapi.com";
const TOPO = process.env.OPEN_TOPO_URL || "https://api.opentopodata.org/v1";

// Nominatim requires User-Agent per their usage policy
const UA = "SpraayGateway/1.0 (https://gateway.spraay.app; x402)";

// ═══════════════════════════════════════════════════════════════
// 1. geocodeHandler — address/place → lat/lng
// ═══════════════════════════════════════════════════════════════
export async function geocodeHandler(req: Request, res: Response) {
  try {
    const { query, limit = 5, countrycodes, language } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });

    const params = new URLSearchParams({
      q: query, format: "jsonv2", limit: String(limit), addressdetails: "1",
    });
    if (countrycodes) params.set("countrycodes", countrycodes);
    if (language) params.set("accept-language", language);

    const resp = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data: any = await resp.json();

    res.json({
      provider: "nominatim",
      count: data.length,
      results: data.map((r: any) => ({
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        display_name: r.display_name,
        type: r.type,
        importance: r.importance,
        address: r.address || {},
        boundingbox: r.boundingbox,
      })),
    });
  } catch (err: any) {
    res.status(502).json({ error: "Geocoding failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. reverseGeocodeHandler — lat/lng → address
// ═══════════════════════════════════════════════════════════════
export async function reverseGeocodeHandler(req: Request, res: Response) {
  try {
    const { lat, lng, language, zoom = 18 } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });

    const params = new URLSearchParams({
      lat: String(lat), lon: String(lng), format: "jsonv2",
      addressdetails: "1", zoom: String(zoom),
    });
    if (language) params.set("accept-language", language);

    const resp = await fetch(`${NOMINATIM}/reverse?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data: any = await resp.json();

    res.json({
      provider: "nominatim",
      lat: parseFloat(data.lat),
      lng: parseFloat(data.lon),
      display_name: data.display_name,
      address: data.address || {},
      type: data.type,
    });
  } catch (err: any) {
    res.status(502).json({ error: "Reverse geocoding failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. routeHandler — turn-by-turn directions
// ═══════════════════════════════════════════════════════════════
export async function routeHandler(req: Request, res: Response) {
  try {
    const { waypoints, profile = "driving" } = req.body;
    if (!waypoints || !Array.isArray(waypoints) || waypoints.length < 2)
      return res.status(400).json({ error: "waypoints array (min 2) with [lng, lat] pairs required" });

    const profileMap: Record<string, string> = {
      driving: "car", car: "car", cycling: "bike", bike: "bike", walking: "foot", foot: "foot",
    };
    const osrmProfile = profileMap[profile] || "car";
    const coords = waypoints.map((w: number[]) => `${w[0]},${w[1]}`).join(";");

    const resp = await fetch(
      `${OSRM}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&steps=true`
    );
    const data: any = await resp.json();

    if (data.code !== "Ok")
      return res.status(422).json({ error: "Routing failed", osrm_code: data.code });

    const route = data.routes[0];
    res.json({
      provider: "osrm",
      distance_m: route.distance,
      duration_s: route.duration,
      geometry: route.geometry,
      legs: route.legs.map((leg: any) => ({
        distance_m: leg.distance,
        duration_s: leg.duration,
        steps: leg.steps.map((s: any) => ({
          instruction: s.maneuver?.type + (s.maneuver?.modifier ? ` ${s.maneuver.modifier}` : ""),
          distance_m: s.distance,
          duration_s: s.duration,
          name: s.name,
        })),
      })),
    });
  } catch (err: any) {
    res.status(502).json({ error: "Routing failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. isochroneHandler — reachability polygon
// ═══════════════════════════════════════════════════════════════
export async function isochroneHandler(req: Request, res: Response) {
  try {
    const { lat, lng, range_seconds = 600, profile = "driving-car" } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });
    if (!ORS_KEY)
      return res.status(503).json({ error: "Isochrone service not configured (ORS_API_KEY missing)" });

    const resp = await fetch(`${ORS}/v2/isochrones/${profile}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: ORS_KEY },
      body: JSON.stringify({ locations: [[lng, lat]], range: [range_seconds], range_type: "time" }),
    });
    const data: any = await resp.json();

    res.json({
      provider: "openrouteservice",
      profile,
      range_seconds,
      center: { lat, lng },
      isochrone: data.features?.[0]?.geometry || null,
      properties: data.features?.[0]?.properties || {},
    });
  } catch (err: any) {
    res.status(502).json({ error: "Isochrone failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. elevationHandler — terrain height at coordinates
// ═══════════════════════════════════════════════════════════════
export async function elevationHandler(req: Request, res: Response) {
  try {
    const { locations, dataset = "srtm30m" } = req.body;
    if (!locations)
      return res.status(400).json({ error: "locations required — [[lat, lng], ...] or { lat, lng }" });

    let locString: string;
    if (Array.isArray(locations)) {
      locString = locations.map((l: any) =>
        Array.isArray(l) ? `${l[0]},${l[1]}` : `${l.lat},${l.lng}`
      ).join("|");
    } else {
      locString = `${locations.lat},${locations.lng}`;
    }

    const resp = await fetch(`${TOPO}/${dataset}?locations=${locString}`);
    const data: any = await resp.json();

    if (data.status !== "OK")
      return res.status(422).json({ error: "Elevation lookup failed", detail: data.error });

    res.json({
      provider: "opentopodata",
      dataset,
      results: data.results.map((r: any) => ({
        lat: r.location.lat,
        lng: r.location.lng,
        elevation_m: r.elevation,
      })),
    });
  } catch (err: any) {
    res.status(502).json({ error: "Elevation lookup failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. weatherHandler — current + forecast
// ═══════════════════════════════════════════════════════════════
export async function weatherHandler(req: Request, res: Response) {
  try {
    const { lat, lng, units = "metric" } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });
    if (!OWM_KEY)
      return res.status(503).json({ error: "Weather service not configured (OPENWEATHER_API_KEY missing)" });

    const [currentResp, forecastResp] = await Promise.all([
      fetch(`${OWM}/weather?lat=${lat}&lon=${lng}&units=${units}&appid=${OWM_KEY}`),
      fetch(`${OWM}/forecast?lat=${lat}&lon=${lng}&units=${units}&cnt=8&appid=${OWM_KEY}`),
    ]);
    const current: any = await currentResp.json();
    const forecast: any = await forecastResp.json();

    if (current.cod !== 200)
      return res.status(422).json({ error: "Weather fetch failed", detail: current.message });

    res.json({
      provider: "openweathermap",
      location: current.name,
      coordinates: { lat, lng },
      current: {
        temp: current.main?.temp, feels_like: current.main?.feels_like,
        humidity: current.main?.humidity, pressure: current.main?.pressure,
        wind_speed: current.wind?.speed, wind_deg: current.wind?.deg,
        description: current.weather?.[0]?.description,
        visibility: current.visibility, clouds: current.clouds?.all,
      },
      forecast: (forecast.list || []).map((f: any) => ({
        dt: f.dt, dt_txt: f.dt_txt, temp: f.main?.temp,
        description: f.weather?.[0]?.description,
        wind_speed: f.wind?.speed,
        rain_3h: f.rain?.["3h"] || 0,
      })),
      units,
    });
  } catch (err: any) {
    res.status(502).json({ error: "Weather fetch failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. weatherAlertsHandler — severe weather
// ═══════════════════════════════════════════════════════════════
export async function weatherAlertsHandler(req: Request, res: Response) {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });
    if (!OWM_KEY)
      return res.status(503).json({ error: "Weather service not configured" });

    // One Call 3.0 — if free plan doesn't support it, falls back gracefully
    const resp = await fetch(
      `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lng}&exclude=minutely,hourly,daily&appid=${OWM_KEY}`
    );
    const data: any = await resp.json();

    if (data.cod && data.cod !== 200)
      return res.status(422).json({
        error: "Weather alerts unavailable on current plan",
        detail: data.message || "One Call 3.0 requires a subscription. Upgrade at openweathermap.org.",
      });

    res.json({
      provider: "openweathermap",
      coordinates: { lat, lng },
      alerts: (data.alerts || []).map((a: any) => ({
        sender: a.sender_name, event: a.event,
        start: a.start, end: a.end,
        description: a.description, tags: a.tags,
      })),
      has_alerts: (data.alerts || []).length > 0,
    });
  } catch (err: any) {
    res.status(502).json({ error: "Weather alerts failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. flightStatusHandler — real-time flight tracking (AeroDataBox)
// ═══════════════════════════════════════════════════════════════
export async function flightStatusHandler(req: Request, res: Response) {
  try {
    const { flight_number, date } = req.body;
    if (!AERO_KEY)
      return res.status(503).json({ error: "Flight tracking not configured (AERODATABOX_RAPIDAPI_KEY missing)" });
    if (!flight_number)
      return res.status(400).json({ error: "flight_number is required (e.g. 'AA100', 'DL47', 'UA2587')" });

    // AeroDataBox: GET /flights/number/{flightNumber} or /flights/number/{flightNumber}/{date}
    const path = date
      ? `/flights/number/${encodeURIComponent(flight_number)}/${date}`
      : `/flights/number/${encodeURIComponent(flight_number)}`;

    const resp = await fetch(`${AERO_BASE}${path}`, {
      headers: {
        "X-RapidAPI-Key": AERO_KEY,
        "X-RapidAPI-Host": AERO_HOST,
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status === 404 ? 404 : 422).json({
        error: "Flight lookup failed",
        status: resp.status,
        detail: errText,
      });
    }

    const data: any = await resp.json();
    // AeroDataBox returns an array of flight objects
    const flights = (Array.isArray(data) ? data : [data]).map((f: any) => ({
      flight: {
        number: f.number,
        iata: f.number,  // AeroDataBox uses "number" field as IATA
        icao: f.callSign,
      },
      airline: {
        name: f.airline?.name,
        code: f.airline?.code?.iata || f.airline?.code?.icao,
      },
      departure: {
        airport: f.departure?.airport?.name,
        iata: f.departure?.airport?.iata,
        icao: f.departure?.airport?.icao,
        scheduled: f.departure?.scheduledTime?.local || f.departure?.scheduledTime?.utc,
        revised: f.departure?.revisedTime?.local || f.departure?.revisedTime?.utc,
        actual: f.departure?.actualTime?.local || f.departure?.actualTime?.utc,
        terminal: f.departure?.terminal,
        gate: f.departure?.gate,
        quality: f.departure?.quality,
      },
      arrival: {
        airport: f.arrival?.airport?.name,
        iata: f.arrival?.airport?.iata,
        icao: f.arrival?.airport?.icao,
        scheduled: f.arrival?.scheduledTime?.local || f.arrival?.scheduledTime?.utc,
        revised: f.arrival?.revisedTime?.local || f.arrival?.revisedTime?.utc,
        actual: f.arrival?.actualTime?.local || f.arrival?.actualTime?.utc,
        terminal: f.arrival?.terminal,
        gate: f.arrival?.gate,
        baggage: f.arrival?.baggageBelt,
      },
      status: f.status,
      aircraft: f.aircraft ? {
        registration: f.aircraft.reg,
        model: f.aircraft.model,
        modeS: f.aircraft.modeS,
      } : null,
      codeshares: f.codeshareStatus,
      live: f.lastUpdatedUtc ? { updated: f.lastUpdatedUtc } : null,
    }));

    res.json({
      provider: "aerodatabox",
      count: flights.length,
      flights,
    });
  } catch (err: any) {
    res.status(502).json({ error: "Flight tracking failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 9. airportInfoHandler — airport data by IATA (AeroDataBox)
// ═══════════════════════════════════════════════════════════════
export async function airportInfoHandler(req: Request, res: Response) {
  try {
    const { iata_code } = req.body;
    if (!iata_code)
      return res.status(400).json({ error: "iata_code is required (e.g. 'LAX', 'JFK', 'SFO')" });
    if (!AERO_KEY)
      return res.status(503).json({ error: "Aviation service not configured (AERODATABOX_RAPIDAPI_KEY missing)" });

    // AeroDataBox: GET /airports/iata/{code}
    const resp = await fetch(`${AERO_BASE}/airports/iata/${encodeURIComponent(iata_code)}`, {
      headers: {
        "X-RapidAPI-Key": AERO_KEY,
        "X-RapidAPI-Host": AERO_HOST,
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status === 404 ? 404 : 422).json({
        error: "Airport lookup failed",
        status: resp.status,
        detail: errText,
      });
    }

    const a: any = await resp.json();

    res.json({
      provider: "aerodatabox",
      airport: {
        name: a.fullName || a.shortName,
        short_name: a.shortName,
        iata: a.iata,
        icao: a.icao,
        lat: a.location?.lat,
        lng: a.location?.lon,
        country: a.country?.name,
        country_code: a.country?.code,
        city: a.municipalityName,
        timezone: a.timeZone,
        elevation_ft: a.elevation?.feet,
        website: a.urls?.webSite,
        wikipedia: a.urls?.wikipedia,
      },
    });
  } catch (err: any) {
    res.status(502).json({ error: "Airport lookup failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 10. distanceMatrixHandler — multi-point distances
// ═══════════════════════════════════════════════════════════════
export async function distanceMatrixHandler(req: Request, res: Response) {
  try {
    const { origins, destinations, profile = "driving-car" } = req.body;
    if (!origins || !destinations)
      return res.status(400).json({ error: "origins and destinations arrays required" });
    if (!ORS_KEY)
      return res.status(503).json({ error: "Distance matrix not configured (ORS_API_KEY missing)" });

    const locations = [...origins, ...destinations];
    const sources = origins.map((_: any, i: number) => i);
    const dests = destinations.map((_: any, i: number) => origins.length + i);

    const resp = await fetch(`${ORS}/v2/matrix/${profile}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: ORS_KEY },
      body: JSON.stringify({ locations, sources, destinations: dests, metrics: ["distance", "duration"] }),
    });
    const data: any = await resp.json();

    res.json({
      provider: "openrouteservice",
      profile,
      durations_s: data.durations,
      distances_m: data.distances,
      origins: data.sources?.map((s: any) => ({ lat: s.location[1], lng: s.location[0] })),
      destinations: data.destinations?.map((d: any) => ({ lat: d.location[1], lng: d.location[0] })),
    });
  } catch (err: any) {
    res.status(502).json({ error: "Distance matrix failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 11. nearbyHandler — POI search near coordinates
// ═══════════════════════════════════════════════════════════════
export async function nearbyHandler(req: Request, res: Response) {
  try {
    const { lat, lng, query, limit = 10 } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });
    if (!query)
      return res.status(400).json({ error: "query is required (e.g. 'gas station', 'hospital', 'helipad')" });

    const params = new URLSearchParams({
      q: query, format: "jsonv2", limit: String(limit), addressdetails: "1",
      viewbox: `${lng - 0.05},${lat + 0.05},${lng + 0.05},${lat - 0.05}`,
      bounded: "1",
    });

    const resp = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data: any = await resp.json();

    res.json({
      provider: "nominatim",
      count: data.length,
      center: { lat, lng },
      results: data.map((r: any) => ({
        name: r.display_name?.split(",")[0],
        display_name: r.display_name,
        lat: parseFloat(r.lat), lng: parseFloat(r.lon),
        type: r.type, category: r.category,
        address: r.address || {},
      })),
    });
  } catch (err: any) {
    res.status(502).json({ error: "Nearby search failed", detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 12. timezoneHandler — timezone at coordinates
// ═══════════════════════════════════════════════════════════════
export async function timezoneHandler(req: Request, res: Response) {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null)
      return res.status(400).json({ error: "lat and lng are required" });

    const params = new URLSearchParams({
      lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "3",
    });
    const resp = await fetch(`${NOMINATIM}/reverse?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data: any = await resp.json();

    res.json({
      provider: "nominatim",
      lat, lng,
      country_code: data.address?.country_code,
      country: data.address?.country,
      display_name: data.display_name,
    });
  } catch (err: any) {
    res.status(502).json({ error: "Timezone lookup failed", detail: err.message });
  }
}
