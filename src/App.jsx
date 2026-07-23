import { useState, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

// Paste your Apps Script Web App URL here after deployment
// (Deploy > New deployment > Web app > copy the /exec URL)
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbyUyZqGshX-MmaaUBvFk6dSSGlEKaxhtPc-rtRXW_m1W0uqdmgFnGcYfOUyaT5hhFhLkA/exec'

// ============================================================
// ANALYSIS TOOLS — published Google Earth Engine apps
// Each tool is one entry. To add another: publish the script in the
// GEE Code Editor (Apps > NEW APP > public), then add an object
// here with its URL. A tool with url: null renders as a "not yet
// published" card instead of a broken frame, so entries can be
// added before the app exists.
// ============================================================
const GEE_BASE = 'https://evocative-fort-427508-j2.projects.earthengine.app/view/'

const GEE_TOOLS = [
  {
    id: 'explorer',
    label: 'Surface water explorer',
    url: GEE_BASE + 'wim',
    blurb:
      'Click any point on Earth for a monthly surface water area series ' +
      'from Sentinel-2, alongside the JRC 1984\u20132021 baseline. The ' +
      'simplest starting point: one click, one water body, one chart.',
    method:
      'Sentinel-2 MNDWI, cloud-masked, monthly median within a fixed ' +
      'radius of the clicked point.',
  },
  {
    id: 'waterbody',
    label: 'Compare water bodies',
    url: GEE_BASE + 'waterbodytimeseries',
    blurb:
      'Delineates the actual water body from the JRC surface water record ' +
      'rather than using a fixed radius, so no buffer needs tuning. Click ' +
      'several bodies to plot them on one chart and compare filling ' +
      'behaviour, then export every series as CSV.',
    method:
      'Water body extent vectorised from JRC Global Surface Water; monthly ' +
      'area computed inside that boundary. Fill percentage expresses each ' +
      'month against the body\u2019s mapped extent, making bodies of ' +
      'different sizes comparable.',
  },
  {
    id: 'beforeafter',
    label: 'Before / after by year',
    url: GEE_BASE + 'wimbeforeafter',
    blurb:
      'Two linked maps with a wipe handle: set a year on each side and drag ' +
      'across a tank to see how it has changed. A filmstrip shows every ' +
      'year as a thumbnail, with water area per year alongside.',
    method:
      'Annual Sentinel-2 median composites, season-matched so like is ' +
      'compared with like. Comparing one year\u2019s January against ' +
      'another year\u2019s July would show monsoon timing, not change.',
  },
  {
    id: 'basins',
    label: 'Catchments and flow',
    url: GEE_BASE + 'wim-basins',
    blurb:
      'Click a point to delineate the catchment draining into it, with the ' +
      'river network and a measure of drainage density. A tank is fed by ' +
      'its catchment, not by the district it sits in \u2014 two tanks in ' +
      'one taluk can behave quite differently.',
    method:
      'HydroSHEDS: HydroBASINS nested drainage units (levels 4\u201312), ' +
      'HydroRIVERS reaches, and flow accumulation. Derived from SRTM at 15 ' +
      'arc-second resolution, so catchments below about one square ' +
      'kilometre are not resolved.',
  },
]

// ============================================================
// DATA-FEED REGISTRY
// Every external source the Observatory reads is declared here.
// To add a new API later: add one entry (id, label, provider,
// url builder, extract) and, if it produces numbers, reference
// the extracted fields in METRIC_GROUPS below. The status rail,
// fetching, and source ledger all follow automatically.
// ============================================================
const FEEDS = [
  {
    id: 'weather',
    label: 'Weather & water balance',
    provider: 'Open-Meteo forecast API',
    required: true,
    url: (p) =>
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${p.lat}&longitude=${p.lon}` +
      '&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration' +
      '&hourly=soil_moisture_3_to_9cm' +
      '&past_days=7&forecast_days=7&timezone=auto',
    extract: (w) => {
      if (!w || !w.daily) return null
      const rain = w.daily.precipitation_sum.map((v) => v ?? 0)
      const sm = (w.hourly?.soil_moisture_3_to_9cm || []).filter((v) => v !== null)
      return {
        dates: w.daily.time,
        rain,
        rainToday: rain[7] ?? 0,
        rainNext7: rain.slice(7).reduce((x, y) => x + y, 0),
        rainPast7: rain.slice(0, 7).reduce((x, y) => x + y, 0),
        tmax: w.daily.temperature_2m_max[7],
        tmin: w.daily.temperature_2m_min[7],
        et0: w.daily.et0_fao_evapotranspiration[7],
        soil: sm.length ? sm[sm.length - 1] : null,
      }
    },
  },
  {
    id: 'flood',
    label: 'River discharge',
    provider: 'Copernicus GloFAS via Open-Meteo',
    url: (p) =>
      'https://flood-api.open-meteo.com/v1/flood' +
      `?latitude=${p.lat}&longitude=${p.lon}` +
      '&daily=river_discharge,river_discharge_max&past_days=7&forecast_days=30',
    extract: (f) => {
      if (!f?.daily) return null
      const fMax = (f.daily.river_discharge_max || []).slice(7).filter((v) => v !== null)
      return {
        discharge: f.daily.river_discharge?.[7] ?? null,
        discharge30Max: fMax.length ? Math.max(...fMax) : null,
      }
    },
  },
  {
    id: 'air',
    label: 'Air quality',
    provider: 'Open-Meteo air-quality API (CAMS)',
    url: (p) =>
      'https://air-quality-api.open-meteo.com/v1/air-quality' +
      `?latitude=${p.lat}&longitude=${p.lon}&hourly=pm2_5,pm10&forecast_days=1`,
    extract: (a) => {
      const pm25 = (a?.hourly?.pm2_5 || []).filter((v) => v !== null)
      const pm10 = (a?.hourly?.pm10 || []).filter((v) => v !== null)
      if (!pm25.length && !pm10.length) return null
      return {
        pm25: pm25.length ? pm25[pm25.length - 1] : null,
        pm10: pm10.length ? pm10[pm10.length - 1] : null,
      }
    },
  },
  {
    id: 'elevation',
    label: 'Elevation',
    provider: 'Open-Meteo elevation API (90 m DEM)',
    url: (p) =>
      `https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`,
    extract: (e) =>
      e?.elevation?.[0] !== undefined ? { elevation: e.elevation[0] } : null,
  },
  {
    id: 'india',
    label: 'India — district data',
    provider: 'data.gov.in via backend (Ministry of Jal Shakti, IMD)',
    needsAdmin: true,
    url: (p, admin) =>
      BACKEND_URL +
      '?action=india&state=' + encodeURIComponent(admin.state) +
      '&district=' + encodeURIComponent(admin.district),
    extract: (r) => {
      if (!r || !r.available) return null
      const agency = (r.in_rain_agency || '')
        .replace(' MODEL', '')
        .replace('IMD GRID', 'IMD gridded')
        .replace('NRSC VIC', 'NRSC VIC')
      return {
        in_district: [r.district, r.state].filter(Boolean).join(', '),
        in_rain_annual: r.in_rain_annual,
        in_rain_monsoon: r.in_rain_monsoon,
        in_rain_source: [agency, r.in_rain_year].filter(Boolean).join(' · '),
        in_rain_note: r.in_rain_note || '',
      }
    },
  },
  {
    id: 'climate',
    label: 'Climate outlook 2045',
    provider: 'CMIP6 downscaled via Open-Meteo',
    url: (p) =>
      'https://climate-api.open-meteo.com/v1/climate' +
      `?latitude=${p.lat}&longitude=${p.lon}` +
      '&start_date=2045-01-01&end_date=2045-12-31' +
      '&models=MRI_AGCM3_2_S&daily=temperature_2m_max,precipitation_sum',
    extract: (c) => {
      const ct = (c?.daily?.temperature_2m_max || []).filter((v) => v !== null)
      const cp = (c?.daily?.precipitation_sum || []).filter((v) => v !== null)
      if (!ct.length && !cp.length) return null
      return {
        projTmax: ct.length ? ct.reduce((x, y) => x + y, 0) / ct.length : null,
        projPrecip: cp.length ? cp.reduce((x, y) => x + y, 0) : null,
      }
    },
  },
]

// Metric tiles, grouped. `field` names come from the FEEDS
// extract functions above.
const METRIC_GROUPS = [
  {
    title: 'Rainfall and water balance',
    metrics: [
      { field: 'rainToday', label: 'Rain today', unit: 'mm', digits: 1 },
      { field: 'rainNext7', label: 'Next 7 days', unit: 'mm', digits: 0 },
      { field: 'soil', label: 'Soil moisture 3–9 cm', unit: 'm³/m³', digits: 2 },
      { field: 'et0', label: 'Evapotranspiration ET₀', unit: 'mm', digits: 1 },
    ],
  },
  {
    title: 'Rivers and terrain',
    metrics: [
      { field: 'discharge', label: 'River discharge today', unit: 'm³/s', digits: 2 },
      { field: 'discharge30Max', label: '30-day forecast peak', unit: 'm³/s', digits: 1 },
      { field: 'elevation', label: 'Elevation', unit: 'm', digits: 0 },
      { field: 'tmax', label: 'Max / min today', unit: '°C', digits: 0, pair: 'tmin' },
    ],
  },
  {
    title: 'India — district records',
    requires: 'in_district',
    metrics: [
      { field: 'in_district', label: 'District', text: true },
      { field: 'in_rain_annual', label: 'Annual rainfall', unit: 'mm', digits: 0 },
      { field: 'in_rain_monsoon', label: 'Monsoon Jun–Sep', unit: 'mm', digits: 0 },
      { field: 'in_rain_source', label: 'Series · year', text: true },
    ],
    note:
      'Gridded model estimates published by the Ministry of Jal Shakti on ' +
      'data.gov.in, not rain-gauge readings. The dataset carries two ' +
      'independent series; the one shown is whichever has the most recent ' +
      'complete year for this district.',
  },
  {
    title: 'Air and climate outlook',
    metrics: [
      { field: 'pm25', label: 'PM2.5 now', unit: 'µg/m³', digits: 0 },
      { field: 'pm10', label: 'PM10 now', unit: 'µg/m³', digits: 0 },
      { field: 'projTmax', label: 'Mean daily max, 2045 (CMIP6)', unit: '°C', digits: 1 },
      { field: 'projPrecip', label: 'Annual rainfall, 2045 (CMIP6)', unit: 'mm', digits: 0 },
    ],
  },
]

// NASA GIBS satellite overlays (WMS, EPSG:3857). Registry-shaped:
// add a layer here and it appears as a chip.
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?'

// Base maps. "Satellite" is a cloud-free mosaic built from the best
// available scenes — distinct from the GIBS layers below, which are
// single-day snapshots and therefore show whatever cloud was present.
const BASE_MAPS = [
  {
    id: 'dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    opts: { subdomains: 'abcd', maxZoom: 19 },
    credit: '© OpenStreetMap contributors, © CARTO',
  },
  {
    id: 'satellite',
    label: 'Satellite (cloud-free)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19 },
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
]

// Country, state and district boundaries with place names.
const BOUNDARY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'

const SAT_LAYERS = [
  { id: 'none', label: 'None', layer: null, legend: null },
  {
    id: 'truecolor',
    label: 'True colour',
    layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    opacity: 1,
    legend:
      'VIIRS corrected reflectance — what the satellite sees. Cloud, sediment plumes, snow and flooding are visible directly. VIIRS images the whole planet each day without swath gaps.',
  },
  {
    id: 'precip',
    label: 'Precipitation',
    layer: 'IMERG_Precipitation_Rate',
    opacity: 0.75,
    legend:
      'GPM IMERG precipitation rate — half-hourly global rainfall from the satellite constellation. Blue is light, red is intense.',
  },
  {
    id: 'lst',
    label: 'Land surface temp',
    layer: 'MODIS_Aqua_Land_Surface_Temp_Day',
    opacity: 0.75,
    legend:
      'MODIS daytime land surface temperature — the skin temperature of the ground, a strong proxy for drought and heat stress.',
  },
  {
    id: 'ndvi',
    label: 'Vegetation',
    layer: 'MODIS_Terra_NDVI_8Day',
    opacity: 0.8,
    legend:
      'MODIS NDVI, 8-day composite — vegetation vigour. Green is dense growth; pale is sparse or stressed cover.',
  },
]

const TIERS = {
  curated: { label: 'Curated source', cls: 'tier-curated' },
  web_verified: { label: 'Web-sourced · human-verified', cls: 'tier-web' },
  pending: { label: 'Logged for review', cls: 'tier-pending' },
}

const EXAMPLES = [
  'What is the permissible fluoride limit in drinking water?',
  'How do percolation tanks recharge groundwater?',
  'भूजल पुनर्भरण क्या है?',
  'ಕುಡಿಯುವ ನೀರಿನ ಗುಣಮಟ್ಟ ಎಂದರೇನು?',
]

const VOICE_LANGS = [
  { code: 'en-IN', label: 'EN' },
  { code: 'hi-IN', label: 'हिं' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ' },
]

const WIM_LAYERS = [
  'Physical systems',
  'Observation',
  'Engineering models',
  'Information',
  'Knowledge',
  'Governance',
  'Intelligence',
]

const TIER_GUIDE = [
  {
    cls: 'dot-curated',
    title: 'Curated source',
    text: 'Standards, official publications and expert-written material, reviewed before it enters the corpus. The strongest tier.',
  },
  {
    cls: 'dot-web',
    title: 'Web-sourced · human-verified',
    text: 'Gathered from the open web, then checked and approved by a domain expert before being admitted.',
  },
  {
    cls: 'dot-pending',
    title: 'Logged for review',
    text: 'The corpus cannot answer this yet. The question is recorded, reviewed by an expert, and the gap is closed.',
  },
]

const LOOP_STEPS = [
  { title: 'You ask', text: 'Any water question, in English, Hindi or Kannada.' },
  { title: 'Corpus search', text: 'Keyword and cross-language semantic search over curated documents.' },
  { title: 'Grounded answer', text: 'Composed only from retrieved passages, never invented, always labelled by tier.' },
  { title: 'Gaps close', text: 'Unanswered questions are logged, expert-reviewed, and folded back into the corpus.' },
]

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function ymd(d) {
  return d.toISOString().slice(0, 10)
}

function defaultSatDate() {
  return ymd(new Date(Date.now() - 2 * 86400000))
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  const cap = new Date(Date.now() - 86400000)
  return d > cap ? ymd(cap) : ymd(d)
}

function prettyDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Number(v).toFixed(digits)
}

function StrataMark({ size = 22 }) {
  return (
    <svg className="strata-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--brand-deep)" />
      <g fill="none" strokeLinecap="round" strokeWidth="2">
        <path d="M8 9h16" stroke="var(--s1)" />
        <path d="M8 13h16" stroke="var(--s2)" />
        <path d="M8 17h16" stroke="var(--s3)" />
        <path d="M8 21h11" stroke="var(--s4)" />
        <path d="M8 25h7" stroke="var(--s5)" />
      </g>
    </svg>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const p = (n) => String(n).padStart(2, '0')

  // UTC is the reference used by satellite and model timestamps;
  // IST is shown alongside for local reading.
  const utc = p(now.getUTCHours()) + ':' + p(now.getUTCMinutes())
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000
  const ist = new Date(istMs)
  const local = p(ist.getHours()) + ':' + p(ist.getMinutes())

  return (
    <span className="clock" aria-label="Current time, UTC and India Standard Time">
      <span className="clock-utc">{utc}<em>UTC</em></span>
      <span className="clock-sep" aria-hidden="true">·</span>
      <span className="clock-ist">{local}<em>IST</em></span>
    </span>
  )
}

// ------------------------------------------------------------
// Observations: runs every registered feed for one point,
// tracking per-feed status for the status rail.
// ------------------------------------------------------------
function useObservations(place) {
  const [d, setD] = useState(null)
  const [status, setStatus] = useState({}) // feedId -> loading|ok|error|off
  const reqId = useRef(0)

  useEffect(() => {
    if (!place) return
    const id = ++reqId.current
    setD(null)
    setStatus(Object.fromEntries(FEEDS.map((f) => [f.id, 'loading'])))

    // Reverse geocoding runs in the browser on purpose: each visitor
    // uses their own IP. Server-side calls from Apps Script share a
    // Google IP pool, which BigDataCloud bans and Nominatim
    // rate-limits. Both were tried; both failed for that reason.
    const resolveAdmin = async () => {
      try {
        const r = await fetch(
          'https://api.bigdatacloud.net/data/reverse-geocode-client' +
            `?latitude=${place.lat}&longitude=${place.lon}&localityLanguage=en`
        )
        const g = await r.json()
        const admins = (g && g.localityInfo && g.localityInfo.administrative) || []
        let district = ''
        admins.forEach((a) => {
          const nm = String(a.name || '')
          if (!district && /district|zilla|zila/i.test(nm)) {
            district = nm.replace(/\s*(district|zilla|zila)\s*/i, '').trim()
          }
        })
        if (!district) {
          let deepest = null
          admins.forEach((a) => {
            if (a.adminLevel >= 5 && (!deepest || a.adminLevel > deepest.adminLevel)) {
              deepest = a
            }
          })
          district = deepest ? deepest.name : (g && (g.city || g.locality)) || ''
        }
        return {
          countryCode: (g && g.countryCode) || '',
          state: (g && g.principalSubdivision) || '',
          district: district,
        }
      } catch {
        return null
      }
    }

    const merged = {}
    const adminPromise = FEEDS.some((f) => f.needsAdmin)
      ? resolveAdmin()
      : Promise.resolve(null)

    FEEDS.forEach((feed) => {
      // Feeds needing administrative context wait for the lookup and
      // switch off cleanly outside India; the rest start immediately.
      const run = feed.needsAdmin
        ? adminPromise.then((admin) => {
            if (id !== reqId.current) return null
            if (!admin || admin.countryCode !== 'IN' || !admin.state) {
              setStatus((s) => ({ ...s, [feed.id]: 'off' }))
              return null
            }
            return fetch(feed.url(place, admin))
          })
        : fetch(feed.url(place))

      Promise.resolve(run)
        .then((r) => (r ? r.json() : null))
        .then((raw) => {
          if (id !== reqId.current || raw === null) return
          const out = feed.extract(raw)
          if (out) {
            Object.assign(merged, out)
            setD({ ...merged })
            setStatus((s) => ({ ...s, [feed.id]: 'ok' }))
          } else {
            setStatus((s) => ({ ...s, [feed.id]: feed.required ? 'error' : 'off' }))
          }
        })
        .catch(() => {
          if (id !== reqId.current) return
          setStatus((s) => ({ ...s, [feed.id]: 'error' }))
        })
    })
  }, [place])

  return { d, status }
}

// ------------------------------------------------------------
// Location search — Open-Meteo geocoding (free, no key, global)
// ------------------------------------------------------------
function PlaceSearch({ onPick }) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const boxRef = useRef(null)
  const reqId = useRef(0)

  useEffect(() => {
    const q = term.trim()
    if (q.length < 2) {
      setHits([])
      setOpen(false)
      return
    }
    const id = ++reqId.current
    setBusy(true)
    const t = setTimeout(() => {
      fetch(
        'https://geocoding-api.open-meteo.com/v1/search?name=' +
          encodeURIComponent(q) +
          '&count=6&language=en&format=json'
      )
        .then((r) => r.json())
        .then((data) => {
          if (id !== reqId.current) return
          setHits(data.results || [])
          setOpen(true)
          setCursor(-1)
        })
        .catch(() => {
          if (id === reqId.current) {
            setHits([])
            setOpen(true)
          }
        })
        .finally(() => {
          if (id === reqId.current) setBusy(false)
        })
    }, 300)
    return () => clearTimeout(t)
  }, [term])

  useEffect(() => {
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function choose(h) {
    onPick({
      name: h.name,
      region: h.admin1 || '',
      country: h.country || '',
      lat: h.latitude,
      lon: h.longitude,
    })
    setTerm('')
    setHits([])
    setOpen(false)
  }

  function onKeyDown(e) {
    if (!open || !hits.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (c + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (c - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(hits[cursor >= 0 ? cursor : 0])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="place-search" ref={boxRef}>
      <input
        type="text"
        value={term}
        placeholder="Search anywhere on Earth…"
        aria-label="Search for a location"
        autoComplete="off"
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => hits.length && setOpen(true)}
      />
      {open && (
        <ul className="place-results" role="listbox">
          {busy && <li className="place-msg">Searching…</li>}
          {!busy && !hits.length && (
            <li className="place-msg">No matching place. Try another spelling.</li>
          )}
          {!busy &&
            hits.map((h, i) => (
              <li key={h.id}>
                <button
                  type="button"
                  className={i === cursor ? 'is-active' : ''}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(h)}
                >
                  <strong>{h.name}</strong>
                  <span>{[h.admin1, h.country].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// The world map. Click any point to read it.
// ------------------------------------------------------------
function WorldMap({ place, onPick, satId, satDate, visible, baseId, boundaries }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const overlayRef = useRef(null)
  const baseRef = useRef(null)
  const boundRef = useRef(null)

  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, {
      center: [20, 10],
      zoom: 2,
      minZoom: 2,
      worldCopyJump: true,
      attributionControl: false,
    })
    map.on('click', (e) => {
      const { lat, lng } = e.latlng
      onPick({
        name: 'Dropped pin',
        region: '',
        country: '',
        lat: +lat.toFixed(4),
        lon: +(((lng + 540) % 360) - 180).toFixed(4),
        pin: true,
      })
    })
    mapRef.current = map
    setTimeout(() => map.invalidateSize(), 0)
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [onPick])

  // tabs keep panels mounted; when this one becomes visible the
  // map needs a size recalculation
  useEffect(() => {
    if (visible && mapRef.current) {
      setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 60)
    }
  }, [visible])

  // base map (swappable)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (baseRef.current) map.removeLayer(baseRef.current)
    const cfg = BASE_MAPS.find((b) => b.id === baseId) || BASE_MAPS[0]
    const layer = L.tileLayer(cfg.url, { ...cfg.opts, zIndex: 1 })
    layer.addTo(map)
    baseRef.current = layer
  }, [baseId])

  // administrative boundaries, drawn above imagery
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (boundRef.current) {
      map.removeLayer(boundRef.current)
      boundRef.current = null
    }
    if (!boundaries) return
    const layer = L.tileLayer(BOUNDARY_URL, { maxZoom: 19, zIndex: 400 })
    layer.addTo(map)
    boundRef.current = layer
  }, [boundaries])

  // satellite overlay
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (overlayRef.current) {
      map.removeLayer(overlayRef.current)
      overlayRef.current = null
    }
    const cfg = SAT_LAYERS.find((s) => s.id === satId)
    if (!cfg || !cfg.layer) return
    const wms = L.tileLayer.wms(GIBS_WMS, {
      layers: cfg.layer,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      time: satDate,
      opacity: cfg.opacity ?? 0.8,
      crossOrigin: true,
      zIndex: 200,
    })
    wms.addTo(map)
    overlayRef.current = wms
  }, [satId, satDate])

  // marker follows the selected place
  useEffect(() => {
    const map = mapRef.current
    if (!map || !place) return
    if (markerRef.current) map.removeLayer(markerRef.current)
    const m = L.circleMarker([place.lat, place.lon], {
      radius: 7,
      color: '#f2fafc',
      weight: 2,
      fillColor: '#6fbfd4',
      fillOpacity: 0.95,
    }).addTo(map)
    markerRef.current = m
    if (!place.pin)
      map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), 7), { duration: 0.8 })
  }, [place])

  return (
    <div
      className="map"
      ref={elRef}
      role="application"
      aria-label="World map. Click a point to read conditions there."
    />
  )
}

function RainChart({ dates, rain, past7, next7 }) {
  const max = Math.max(1, ...rain)
  const W = 560
  const H = 110
  const gap = 6
  const bw = (W - gap * (rain.length - 1)) / rain.length
  return (
    <div className="rain-chart-wrap">
      <svg
        className="rain-chart"
        viewBox={`0 0 ${W} ${H + 22}`}
        role="img"
        aria-label="Daily rainfall in millimetres: past seven days and seven-day forecast"
      >
        {rain.map((v, i) => {
          const h = Math.max(2, (v / max) * H)
          const x = i * (bw + gap)
          const dt = new Date(dates[i] + 'T00:00:00')
          return (
            <g key={dates[i]}>
              <rect
                x={x}
                y={H - h}
                width={bw}
                height={h}
                rx="2.5"
                className={i < 7 ? 'bar-past' : 'bar-fcst'}
              >
                <title>{`${dates[i]}: ${fmt(v)} mm`}</title>
              </rect>
              <text x={x + bw / 2} y={H + 15} className="bar-label" textAnchor="middle">
                {dt.getDate()}
              </text>
            </g>
          )
        })}
        <line
          x1={7 * (bw + gap) - gap / 2}
          y1="0"
          x2={7 * (bw + gap) - gap / 2}
          y2={H}
          className="today-line"
        />
      </svg>
      <div className="rain-legend">
        <span>
          <i className="swatch swatch-past" /> Past 7 days · {fmt(past7, 0)} mm
        </span>
        <span>
          <i className="swatch swatch-fcst" /> Next 7 days · {fmt(next7, 0)} mm
        </span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// SPEECH OUTPUT
// Script-based detection: Devanagari, Kannada and Latin ranges do
// not overlap, so this is deterministic and needs no model.
// Known limit: romanised input ("paani kitna hai") reads as
// English, which is common on Indian phone keyboards.
//
// The provider is deliberately behind one function. Browser speech
// synthesis works today with no key or backend. To move to
// Bhashini later, replace the body of speak() with a call to the
// backend proxy; nothing else in the component changes.
// ------------------------------------------------------------
const DEVANAGARI = /[\u0900-\u097F]/g
const KANNADA = /[\u0C80-\u0CFF]/g
const LATIN = /[A-Za-z]/g

function detectLang(text) {
  const counts = {
    'hi-IN': (text.match(DEVANAGARI) || []).length,
    'kn-IN': (text.match(KANNADA) || []).length,
    'en-IN': (text.match(LATIN) || []).length,
  }
  const best = Object.keys(counts).reduce((a, b) =>
    counts[a] >= counts[b] ? a : b
  )
  return counts[best] ? best : 'en-IN'
}

function pickVoice(lang) {
  const voices = window.speechSynthesis?.getVoices() || []
  if (!voices.length) return null
  // exact locale, then language family, then any Indian English
  return (
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang.startsWith(lang.split('-')[0])) ||
    voices.find((v) => v.lang === 'en-IN') ||
    null
  )
}

// ------------------------------------------------------------
// Reference desk — the assistant, docked as a console panel
// ------------------------------------------------------------
function Console({ prefill }) {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceLang, setVoiceLang] = useState('en-IN')
  const [speaking, setSpeaking] = useState(false)
  const [canSpeak, setCanSpeak] = useState(false)
  const recRef = useRef(null)

  // Voices load asynchronously in most browsers.
  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const check = () => setCanSpeak((synth.getVoices() || []).length > 0)
    check()
    synth.addEventListener?.('voiceschanged', check)
    return () => {
      synth.removeEventListener?.('voiceschanged', check)
      synth.cancel()
    }
  }, [])

  function speak(text) {
    const synth = window.speechSynthesis
    if (!synth || !text) return
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    const lang = detectLang(text)
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    const v = pickVoice(lang)
    if (v) u.voice = v
    u.rate = 0.95
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    setSpeaking(true)
    synth.speak(u)
  }

  const SR =
    typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    if (prefill) setQuestion(prefill.text)
  }, [prefill])

  function toggleMic() {
    if (!SR) return
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = new SR()
    rec.lang = voiceLang
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e) => {
      const t = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(' ')
      setQuestion(t)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  async function ask(q) {
    const query = (q ?? question).trim()
    if (!query || loading) return
    setQuestion(query)
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      // No Content-Type header on purpose: the body is sent as
      // text/plain, which avoids the CORS preflight that Apps Script
      // cannot answer. The backend JSON-parses the raw body.
      const res = await fetch(BACKEND_URL, {
        method: 'POST',
        body: JSON.stringify({ question: query }),
        redirect: 'follow',
      })
      const data = await res.json()
      if (data.error) setError(data.error)
      else setResult(data)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  const tier = result ? TIERS[result.tier] || { label: result.tier, cls: '' } : null

  return (
    <aside className="console" aria-label="Ask the corpus">
      <header className="panel-head">
        <span className="panel-title">WIM-Assistant</span>
        <span className="panel-note">EN · हिंदी · ಕನ್ನಡ</span>
      </header>

      <div className="console-body">
        <p className="console-hint">
          Ask anything related to water resources fundamentals, engineering,
          and governance. Answers come from a curated corpus and carry a
          source tier.
        </p>

        <div className="console-input">
          <input
            type="text"
            value={question}
            placeholder="Ask a question…"
            aria-label="Your question"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
          />
          {SR && (
            <button
              className={`mic-btn${listening ? ' is-listening' : ''}`}
              onClick={toggleMic}
              aria-label={listening ? 'Stop listening' : 'Ask by voice'}
              title={listening ? 'Stop listening' : 'Ask by voice'}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm-6.5 8a.9.9 0 0 1 1.8 0 4.7 4.7 0 0 0 9.4 0 .9.9 0 0 1 1.8 0 6.5 6.5 0 0 1-5.6 6.43V20h2.2a.9.9 0 0 1 0 1.8H8.9a.9.9 0 0 1 0-1.8h2.2v-2.57A6.5 6.5 0 0 1 5.5 11Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          )}
          <button className="ask-btn" onClick={() => ask()} disabled={loading}>
            {loading ? '…' : 'Ask'}
          </button>
        </div>

        {SR && (
          <div className="voice-row">
            {listening && (
              <span className="voice-label">Listening — speak now</span>
            )}
            <div className="voice-langs" role="group" aria-label="Voice language">
              {VOICE_LANGS.map((v) => (
                <button
                  key={v.code}
                  className={`voice-lang${voiceLang === v.code ? ' is-on' : ''}`}
                  onClick={() => setVoiceLang(v.code)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!result && !loading && !error && (
          <div className="console-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => ask(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="console-answer">
            <div className="pulse-strata">
              <span /><span /><span /><span /><span />
            </div>
            <p className="loading-text">Searching the corpus…</p>
          </div>
        )}

        {error && (
          <div className="console-answer is-error">
            <p className="error-title">Something went wrong</p>
            <p className="error-text">{error}</p>
          </div>
        )}

        {result && (
          <article className="console-answer">
            <div className="badges">
              <span className={`badge ${tier.cls}`}>{tier.label}</span>
              {result.category === 'governance' && (
                <span className="badge badge-gov">
                  Policy / legal — verify against the current official source
                </span>
              )}
            </div>
            <p className="answer-text">{result.answer}</p>
            {canSpeak && (
              <button
                className={`speak-btn${speaking ? ' is-speaking' : ''}`}
                onClick={() => speak(result.answer)}
                aria-label={speaking ? 'Stop reading' : 'Read this answer aloud'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  {speaking ? (
                    <path d="M7 6h3.5v12H7zm6.5 0H17v12h-3.5z" fill="currentColor" />
                  ) : (
                    <path
                      d="M4 9.5h3.2L12 5.3v13.4L7.2 14.5H4zM15.5 9a3.6 3.6 0 0 1 0 6 .9.9 0 0 1-.7-1.6 1.8 1.8 0 0 0 0-2.8.9.9 0 0 1 .7-1.6Zm1.4-3a7 7 0 0 1 0 12 .9.9 0 1 1-.8-1.6 5.2 5.2 0 0 0 0-8.8.9.9 0 0 1 .8-1.6Z"
                      fill="currentColor"
                    />
                  )}
                </svg>
                {speaking ? 'Stop' : 'Listen'}
              </button>
            )}
            {result.source && (
              <p className="answer-source">Source: {result.source}</p>
            )}
          </article>
        )}
      </div>
    </aside>
  )
}

// ------------------------------------------------------------
// About view
// ------------------------------------------------------------
function About() {
  return (
    <div className="about">
      <div className="about-inner">
        <section className="about-block">
          <h1>What is WIM?</h1>
          <p className="about-text">
            Water Intelligence Modeling is a framework that integrates water
            data, engineering knowledge, environmental processes, and
            governance into a single evolving knowledge model. WIM-Assistant is
            its intelligence layer: it explains, interprets regulations, and
            learns continuously. Questions it cannot yet answer are logged,
            reviewed by domain experts, and folded back into the corpus.
          </p>
          <ol className="layers" aria-label="The seven layers of WIM">
            {WIM_LAYERS.map((l, i) => (
              <li key={l} style={{ '--i': i }}>
                <span className="layer-bar" />
                {l}
              </li>
            ))}
          </ol>
        </section>

        <section className="about-block">
          <h2>Every answer tells you where it came from</h2>
          <div className="tier-cards">
            {TIER_GUIDE.map((t) => (
              <div key={t.title} className="tier-card">
                <span className={`tier-dot ${t.cls}`} aria-hidden="true" />
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </div>
            ))}
          </div>
          <p className="gov-note">
            Answers touching policy, law or schemes additionally carry a
            standing caveat: verify against the current official source,
            because rules change and a stale answer can mislead.
          </p>
        </section>

        <section className="about-block">
          <h2>How it learns</h2>
          <ol className="loop-steps">
            {LOOP_STEPS.map((st) => (
              <li key={st.title}>
                <h3>{st.title}</h3>
                <p>{st.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Analysis — satellite water-area explorer, embedded from the
// published Earth Engine App.
// ------------------------------------------------------------
function Analysis() {
  const [toolId, setToolId] = useState(GEE_TOOLS[0].id)
  const tool = GEE_TOOLS.find((t) => t.id === toolId) || GEE_TOOLS[0]

  return (
    <div className="analysis">
      <div className="analysis-bar">
        <div className="analysis-bar-inner">
          <span className="rail-label">Engineering models · Earth Engine</span>
          <div className="tool-tabs" role="tablist" aria-label="Analysis tools">
            {GEE_TOOLS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={toolId === t.id}
                className={`tool-tab${toolId === t.id ? ' is-on' : ''}${
                  t.url ? '' : ' is-pending'
                }`}
                onClick={() => setToolId(t.id)}
              >
                {t.label}
                {!t.url && <em>soon</em>}
              </button>
            ))}
          </div>
          {tool.url && (
            <a
              className="analysis-open"
              href={tool.url}
              target="_blank"
              rel="noreferrer"
            >
              Open full screen &nearr;
            </a>
          )}
        </div>
      </div>

      <p className="analysis-note">{tool.blurb}</p>

      {tool.url ? (
        <iframe
          key={tool.id}
          className="analysis-frame"
          src={tool.url}
          title={tool.label + ', powered by Google Earth Engine'}
          loading="lazy"
        />
      ) : (
        <div className="analysis-pending">
          <StrataMark size={30} />
          <div>
            <h3>Not published yet</h3>
            <p>
              This tool exists as an Earth Engine script but has not been
              published as a public app. Once it is, it will appear here.
            </p>
          </div>
        </div>
      )}

      <p className="analysis-credit">
        <strong>Method.</strong> {tool.method} Analysis runs on Google Earth
        Engine using Copernicus Sentinel-2 data and the JRC Global Surface
        Water dataset. Water extent is derived by index thresholding and
        should be validated against ground observations before use in
        decisions. Months without cloud-free imagery are omitted rather than
        recorded as zero.
      </p>
    </div>
  )
}

const VIEWS = ['observatory', 'analysis', 'about']

// ------------------------------------------------------------
// App — the instrument. Map first; console docked beside the
// readout; About behind a header link.
// ------------------------------------------------------------
function App() {
  const [view, setView] = useState(() => {
    const h = window.location.hash.slice(1)
    return VIEWS.indexOf(h) !== -1 ? h : 'observatory'
  })
  const [place, setPlace] = useState(null)
  const [satId, setSatId] = useState('truecolor')
  const [satDate, setSatDate] = useState(defaultSatDate())
  const [baseId, setBaseId] = useState('satellite')
  const [boundaries, setBoundaries] = useState(true)
  const [geoMsg, setGeoMsg] = useState('')
  const [showOsm, setShowOsm] = useState(false)
  const [osm, setOsm] = useState(null)
  const [osmBusy, setOsmBusy] = useState(false)
  const [prefill, setPrefill] = useState(null)
  const { d, status } = useObservations(place)

  // Physical systems load on demand: the Overpass query is heavy and
  // most visitors will not need it.
  useEffect(() => {
    if (!showOsm || !place) {
      setOsm(null)
      return
    }
    let cancelled = false
    setOsmBusy(true)
    fetch(OVERPASS_URL, {
      method: 'POST',
      body: overpassQuery(place.lat, place.lon, OSM_RADIUS_M),
    })
      .then((r) => r.json())
      .then((d2) => {
        if (cancelled) return
        setOsm({ groups: classifyOsm(d2.elements) })
      })
      .catch(() => {
        if (!cancelled) setOsm({ groups: null, failed: true })
      })
      .finally(() => {
        if (!cancelled) setOsmBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [showOsm, place])

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1)
      setView(VIEWS.indexOf(h) !== -1 ? h : 'observatory')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  function go(v) {
    setView(v)
    history.replaceState(null, '', v === 'observatory' ? '#' : '#' + v)
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setGeoMsg('This browser does not support location.')
      return
    }
    setGeoMsg('Locating…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoMsg('')
        setPlace({
          name: 'My location',
          region: '',
          country: '',
          lat: +pos.coords.latitude.toFixed(4),
          lon: +pos.coords.longitude.toFixed(4),
        })
      },
      (err) => {
        // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
        var msg =
          err.code === 1
            ? 'Location permission blocked. Click the icon at the left of the address bar and allow location, then try again.'
            : err.code === 2
              ? 'Position unavailable. Check that location services are switched on for your device.'
              : 'Location timed out. Try once more.'
        setGeoMsg(msg)
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
    )
  }

  function askAbout(p) {
    const region = [p.region, p.country].filter(Boolean).join(', ')
    setPrefill({
      text: `Tell me about water in ${p.name}${region ? ', ' + region : ''}`,
      at: Date.now(),
    })
    document
      .querySelector('.console')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const sat = SAT_LAYERS.find((x) => x.id === satId)
  const whereParts = [place?.region, place?.country].filter(
    (x, i, arr) => Boolean(x) && x !== place?.name && arr.indexOf(x) === i
  )
  const where = whereParts.join(' · ')
  const anyLoading = Object.values(status).some((v) => v === 'loading')
  const anyError = Object.values(status).some((v) => v === 'error')
  const weatherOk = status.weather === 'ok'

  return (
    <div className="shell">
      <header className="chrome">
        <div className="chrome-inner">
          <span className="brand">
            <StrataMark size={20} />
            <span className="brand-text">
              <strong>WIM</strong>
              <span className="brand-sub">Water Intelligence Modeling</span>
            </span>
          </span>
          <Clock />
          <nav className="chrome-nav">
            <span
              className={`feed-summary ${
                anyError ? 'is-warn' : anyLoading ? 'is-busy' : 'is-ok'
              }`}
              title="Data feed health"
            >
              <i /> feeds
            </span>
            <button
              className={`chrome-link${view === 'observatory' ? ' is-on' : ''}`}
              onClick={() => go('observatory')}
            >
              Observatory
            </button>
            <button
              className={`chrome-link${view === 'analysis' ? ' is-on' : ''}`}
              onClick={() => go('analysis')}
            >
              Analysis
            </button>
            <button
              className={`chrome-link${view === 'about' ? ' is-on' : ''}`}
              onClick={() => go('about')}
            >
              About
            </button>
          </nav>
        </div>
      </header>

      <main className="views">
      <div hidden={view !== 'observatory'} className="workspace">
        <div className="toolstrip">
          <div className="toolstrip-inner">
            <PlaceSearch onPick={setPlace} />
            <div className="sat-chips">
              {SAT_LAYERS.map((x) => (
                <button
                  key={x.id}
                  className={`sat-chip${satId === x.id ? ' is-on' : ''}`}
                  onClick={() => setSatId(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <div className="base-switch" role="group" aria-label="Base map">
              {BASE_MAPS.map((b) => (
                <button
                  key={b.id}
                  className={`base-btn${baseId === b.id ? ' is-on' : ''}`}
                  onClick={() => setBaseId(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>

            <button
              className={`bound-btn${showOsm ? ' is-on' : ''}`}
              onClick={() => setShowOsm((v) => !v)}
              title="Rivers, tanks, dams and wells from OpenStreetMap"
              aria-pressed={showOsm}
            >
              {osmBusy ? 'Loading…' : 'Water systems'}
            </button>

            <button
              className={`bound-btn${boundaries ? ' is-on' : ''}`}
              onClick={() => setBoundaries((v) => !v)}
              title="Country, state and district boundaries"
              aria-pressed={boundaries}
            >
              Boundaries
            </button>

            <button
              className="locate-btn"
              onClick={locateMe}
              title="Use my current location"
              aria-label="Use my current location"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.2 3.1h-1.66a7.55 7.55 0 0 0-6.64-6.64V2.8a.9.9 0 0 0-1.8 0v1.66a7.55 7.55 0 0 0-6.64 6.64H2.8a.9.9 0 0 0 0 1.8h1.66a7.55 7.55 0 0 0 6.64 6.64v1.66a.9.9 0 0 0 1.8 0v-1.66a7.55 7.55 0 0 0 6.64-6.64h1.66a.9.9 0 0 0 0-1.8ZM12 17.75A5.75 5.75 0 1 1 17.75 12 5.76 5.76 0 0 1 12 17.75Z"
                  fill="currentColor"
                />
              </svg>
            </button>
            {satId !== 'none' && (
              <div className="sat-date">
                <button onClick={() => setSatDate((v) => shiftDate(v, -1))} aria-label="Previous day">
                  ‹
                </button>
                <span>{prettyDate(satDate)}</span>
                <button onClick={() => setSatDate((v) => shiftDate(v, 1))} aria-label="Next day">
                  ›
                </button>
              </div>
            )}
          </div>
        </div>

        <WorldMap
          place={place}
          onPick={setPlace}
          satId={satId}
          satDate={satDate}
          visible={view === 'observatory'}
          baseId={baseId}
          boundaries={boundaries}
        />

        <div className="statusbar">
          <div className="statusbar-inner">
            {geoMsg && <span className="st-geo">{geoMsg}</span>}
            {place ? (
              <>
                <span className="st-place">{place.name}</span>
                {where && <span className="st-where">{where}</span>}
                <span className="st-coords">
                  {fmt(place.lat, 3)}°, {fmt(place.lon, 3)}°
                </span>
                {anyLoading && <span className="st-reading">reading…</span>}
                {showOsm && osmBusy && (
                  <span className="st-reading">loading water systems…</span>
                )}
                {showOsm && osm && osm.groups && (
                  <span className="st-osm">
                    {Object.values(osm.groups).reduce(
                      (t, g) => t + g.items.length,
                      0
                    )}{' '}
                    water features · zoom in to see them
                  </span>
                )}
                {!place.pin && (
                  <button className="ask-about" onClick={() => askAbout(place)}>
                    Ask about {place.name} →
                  </button>
                )}
              </>
            ) : showOsm ? (
              <span className="st-empty">
                Water systems on — click a point to load rivers, tanks and
                wells within 3 km of it
              </span>
            ) : (
              <span className="st-empty">
                Click the map or search a place to read conditions ·{' '}
                {sat && sat.layer ? sat.label + ' imagery, ' + prettyDate(satDate) : 'no imagery layer'}
              </span>
            )}
          </div>
        </div>

        <div className="workbench">
          <section className="readout" aria-label="Live readout">
            {!place && (
              <div className="ob-empty">
                <StrataMark size={28} />
                <p>
                  No point selected. The readout fills in here — rainfall and
                  water balance, rivers and terrain, air and climate outlook —
                  for any point on Earth.
                </p>
              </div>
            )}

            {place && status.weather === 'error' && (
              <p className="live-status">
                The weather feed could not read this point. Try another point
                or retry in a moment.
              </p>
            )}

            {place && weatherOk && d && (
              <>
                {METRIC_GROUPS.filter(
                  (g) => !g.requires || d[g.requires]
                ).map((g) => (
                  <div key={g.title}>
                    <h2 className="group-head">{g.title}</h2>
                    <div className="metrics">
                      {g.metrics.map((m) => (
                        <div key={m.field} className="metric">
                          <span
                            className={`metric-value${m.text ? ' is-text' : ''}`}
                          >
                            {m.text
                              ? d[m.field] || '—'
                              : fmt(d[m.field], m.digits)}
                            {!m.text &&
                              (m.pair ? (
                                <span className="metric-sub">
                                  {' '}
                                  / {fmt(d[m.pair], m.digits)}°
                                </span>
                              ) : (
                                <em>{m.unit}</em>
                              ))}
                          </span>
                          <span className="metric-label">{m.label}</span>
                        </div>
                      ))}
                    </div>
                    {g.note && <p className="group-note">{g.note}</p>}
                    {g.title === 'Rainfall and water balance' && d.dates && (
                      <RainChart
                        dates={d.dates}
                        rain={d.rain}
                        past7={d.rainPast7}
                        next7={d.rainNext7}
                      />
                    )}
                  </div>
                ))}
              </>
            )}

            <div className="feeds">
              <h2 className="group-head">Connected data feeds</h2>
              <ul className="feed-list">
                {FEEDS.map((f) => (
                  <li key={f.id} className="feed">
                    <span className={`feed-dot feed-${status[f.id] || 'idle'}`} aria-hidden="true" />
                    <span className="feed-name">{f.label}</span>
                    <span className="feed-provider">{f.provider}</span>
                  </li>
                ))}
                <li className="feed">
                  <span className="feed-dot feed-ok" aria-hidden="true" />
                  <span className="feed-name">Satellite imagery</span>
                  <span className="feed-provider">NASA GIBS — VIIRS, MODIS, GPM IMERG</span>
                </li>
                <li className="feed">
                  <span className="feed-dot feed-ok" aria-hidden="true" />
                  <span className="feed-name">Place search · base map</span>
                  <span className="feed-provider">
                    Open-Meteo geocoding · © OpenStreetMap, © CARTO ·
                    imagery and boundaries © Esri, Maxar, Earthstar Geographics
                  </span>
                </li>
              </ul>
              <p className="live-note">
                Open, keyless APIs read directly in your browser — weather by{' '}
                <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
                  Open-Meteo.com
                </a>{' '}
                (CC-BY 4.0), imagery via NASA{' '}
                <a href="https://worldview.earthdata.nasa.gov/" target="_blank" rel="noreferrer">
                  GIBS / Worldview
                </a>
                . Model and satellite products for orientation and education,
                not official warnings; coarse at local scale. For decisions,
                use the responsible national meteorological, hydrological or
                disaster management agency.
              </p>
            </div>
          </section>

          <Console prefill={prefill} />
        </div>
      </div>

      <div hidden={view !== 'analysis'} className="view-panel">
        <Analysis />
      </div>

      <div hidden={view !== 'about'} className="view-panel">
        <About />
      </div>
      </main>

      <footer className="footer">
        <p>
          A Water Intelligence Modeling initiative · Built on open data —
          Open-Meteo, Copernicus, NASA EOSDIS, OpenStreetMap.
        </p>
      </footer>
    </div>
  )
}

export default App
