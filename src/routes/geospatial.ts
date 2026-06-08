/**
 * ═══════════════════════════════════════════════════════════════
 * 💧 Spraay Gateway — Geospatial & Spatial Intelligence Handlers
 * ═══════════════════════════════════════════════════════════════
 *
 * Individual handler functions matching the gateway pattern.
 * Each handler is exported and registered via app.post() in index.ts.
 *
 * Providers:
 *   Open Topo Data         — elevation
 *   OpenWeatherMap         — weather, alerts
 *   AeroDataBox (RapidAPI) — flight status, airport info ($0.99/mo)
 *
 * NOTE: OSM-backed handlers (geocode, reverse-geocode, route, isochrone,
 * distance-matrix, nearby, timezone) were removed to comply with the
 * OSM/Nominatim and OpenRouteService usage policies, which prohibit
 * reselling their public services. Do not re-add them on OSM public
 * infrastructure — self-host the engines or use a reseller-licensed
 * provider before reintroducing those endpoints.
 *
 * Env vars:
 *   OPEN_TOPO_URL, OPENWEATHER_API_KEY, AERODATABOX_RAPIDAPI_KEY
 */

import { Request, Response } from "express";

// ─── Provider URLs (swap to self-hosted when volume demands it) ───
const OWM = "https://api.openweathermap.org/data/2.5";
const OWM_KEY = process.env.OPENWEATHER_API_KEY || "";
const AERO_BASE = "https://aerodatabox.p.rapidapi.com";
const AERO_KEY = process.env.AERODATABOX_RAPIDAPI_KEY || "";
const AERO_HOST = "aerodatabox.p.rapidapi.com";
const TOPO = process.env.OPEN_TOPO_URL || "https://api.opentopodata.org/v1";

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
