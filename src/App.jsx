import { useState, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

// Paste your Apps Script Web App URL here after deployment
// (Deploy > New deployment > Web app > copy the /exec URL)
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbyUyZqGshX-MmaaUBvFk6dSSGlEKaxhtPc-rtRXW_m1W0uqdmgFnGcYfOUyaT5hhFhLkA/exec'

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

const LAYERS = [
  'Physical systems',
  'Observation',
  'Engineering models',
  'Information',
  'Knowledge',
  'Governance',
  'Intelligence',
]

// Opening view: the whole planet. Any point on Earth can be
// clicked or searched.
const START = { name: 'Select a point', region: '', country: '', lat: 20, lon: 0 }

// ------------------------------------------------------------
// NASA GIBS satellite overlays, served over WMS (EPSG:3857).
// WMS is used rather than WMTS because it handles the time
// dimension without hardcoded tile-matrix levels.
// ------------------------------------------------------------
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?'

const SAT_LAYERS = [
  { id: 'none', label: 'None', layer: null, legend: null },
  {
    id: 'truecolor',
    label: 'True colour',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    opacity: 1,
    legend: 'MODIS Terra corrected reflectance — what the satellite sees. Cloud, sediment plumes, snow and flooding are all visible directly.',
  },
  {
    id: 'precip',
    label: 'Precipitation',
    layer: 'IMERG_Precipitation_Rate',
    opacity: 0.75,
    legend: 'GPM IMERG precipitation rate — half-hourly global rainfall from the satellite constellation. Blue is light, red is intense.',
  },
  {
    id: 'lst',
    label: 'Land surface temp',
    layer: 'MODIS_Terra_Land_Surface_Temp_Day',
    opacity: 0.75,
    legend: 'MODIS daytime land surface temperature — the skin temperature of the ground, a strong proxy for drought and heat stress.',
  },
  {
    id: 'ndvi',
    label: 'Vegetation',
    layer: 'MODIS_Terra_NDVI_8Day',
    opacity: 0.8,
    legend: 'MODIS NDVI, 8-day composite — vegetation vigour. Green is dense growth; pale is sparse or stressed cover.',
  },
]

// GIBS daily products lag acquisition, so ask for a recent past
// day rather than today (today is often empty worldwide).
function gibsDate() {
  const d = new Date(Date.now() - 3 * 86400000)
  return d.toISOString().slice(0, 10)
}

function StrataMark({ size = 22 }) {
  return (
    <svg
      className="strata-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
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

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Number(v).toFixed(digits)
}

// ------------------------------------------------------------
// All observation data for one point on Earth. Every source is
// free, keyless and CORS-enabled, so it runs entirely in the
// browser with no backend involved.
// ------------------------------------------------------------
function useObservations(place) {
  const [d, setD] = useState(null)
  const [state, setState] = useState('idle') // idle | loading | ok | error
  const reqId = useRef(0)

  useEffect(() => {
    if (place.lat === null) return
    const id = ++reqId.current
    setState('loading')

    const j = (u) => fetch(u).then((r) => r.json()).catch(() => null)
    const { lat, lon } = place

    const weather = j(
      'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${lat}&longitude=${lon}` +
        '&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration' +
        '&hourly=soil_moisture_3_to_9cm' +
        '&past_days=7&forecast_days=7&timezone=auto'
    )
    const flood = j(
      'https://flood-api.open-meteo.com/v1/flood' +
        `?latitude=${lat}&longitude=${lon}` +
        '&daily=river_discharge,river_discharge_max&past_days=7&forecast_days=30'
    )
    const air = j(
      'https://air-quality-api.open-meteo.com/v1/air-quality' +
        `?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10&forecast_days=1`
    )
    const elev = j(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`
    )
    const climate = j(
      'https://climate-api.open-meteo.com/v1/climate' +
        `?latitude=${lat}&longitude=${lon}` +
        '&start_date=2045-01-01&end_date=2045-12-31' +
        '&models=MRI_AGCM3_2_S&daily=temperature_2m_max,precipitation_sum'
    )

    Promise.all([weather, flood, air, elev, climate])
      .then(([w, f, a, e, c]) => {
        if (id !== reqId.current) return
        if (!w || !w.daily) throw new Error('no weather')

        const rain = w.daily.precipitation_sum.map((v) => v ?? 0)
        const sm = (w.hourly?.soil_moisture_3_to_9cm || []).filter((v) => v !== null)
        const pm25 = (a?.hourly?.pm2_5 || []).filter((v) => v !== null)
        const pm10 = (a?.hourly?.pm10 || []).filter((v) => v !== null)
        const fMax = (f?.daily?.river_discharge_max || [])
          .slice(7)
          .filter((v) => v !== null)
        const ct = (c?.daily?.temperature_2m_max || []).filter((v) => v !== null)
        const cp = (c?.daily?.precipitation_sum || []).filter((v) => v !== null)

        setD({
          dates: w.daily.time,
          rain,
          rainToday: rain[7] ?? 0,
          rainNext7: rain.slice(7).reduce((x, y) => x + y, 0),
          rainPast7: rain.slice(0, 7).reduce((x, y) => x + y, 0),
          tmax: w.daily.temperature_2m_max[7],
          tmin: w.daily.temperature_2m_min[7],
          et0: w.daily.et0_fao_evapotranspiration[7],
          soil: sm.length ? sm[sm.length - 1] : null,
          discharge: f?.daily?.river_discharge?.[7] ?? null,
          discharge30Max: fMax.length ? Math.max(...fMax) : null,
          pm25: pm25.length ? pm25[pm25.length - 1] : null,
          pm10: pm10.length ? pm10[pm10.length - 1] : null,
          elevation: e?.elevation?.[0] ?? null,
          projTmax: ct.length ? ct.reduce((x, y) => x + y, 0) / ct.length : null,
          projPrecip: cp.length ? cp.reduce((x, y) => x + y, 0) : null,
        })
        setState('ok')
      })
      .catch(() => {
        if (id === reqId.current) setState('error')
      })
  }, [place])

  return { d, state }
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
function WorldMap({ place, onPick, satId }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const overlayRef = useRef(null)

  // create once
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      worldCopyJump: true,
      attributionControl: false,
    })
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { subdomains: 'abcd', maxZoom: 19 }
    ).addTo(map)

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
    // size correctly once laid out
    setTimeout(() => map.invalidateSize(), 0)
  }, [onPick])

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
      time: gibsDate(),
      opacity: cfg.opacity ?? 0.8,
      crossOrigin: true,
    })
    wms.addTo(map)
    overlayRef.current = wms
  }, [satId])

  // marker follows the selected place
  useEffect(() => {
    const map = mapRef.current
    if (!map || place.lat === null) return
    if (markerRef.current) map.removeLayer(markerRef.current)
    const m = L.circleMarker([place.lat, place.lon], {
      radius: 7,
      color: '#f2fafc',
      weight: 2,
      fillColor: '#6fbfd4',
      fillOpacity: 0.95,
    }).addTo(map)
    markerRef.current = m
    if (!place.pin) map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), 7), { duration: 0.8 })
  }, [place])

  return <div className="map" ref={elRef} role="application" aria-label="World map. Click a point to read conditions there." />
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

function Observatory() {
  const [place, setPlace] = useState(START)
  const [satId, setSatId] = useState('truecolor')
  const { d, state } = useObservations(place)

  const sat = SAT_LAYERS.find((s) => s.id === satId)
  const where = [place.region, place.country].filter(Boolean).join(' · ')
  const chosen = place.lat !== null && place !== START

  return (
    <section id="live" className="live">
      <div className="live-inner">
        <div className="live-head">
          <div>
            <p className="eyebrow eyebrow-light">Observation layer · live</p>
            <h2>The water observatory</h2>
            <p className="live-sub">
              Click anywhere on Earth, or search a place, to read current
              conditions from open satellite and model data.
            </p>
          </div>
          <PlaceSearch onPick={setPlace} />
        </div>

        <div className="sat-bar">
          <span className="sat-label">Satellite layer</span>
          <div className="sat-chips">
            {SAT_LAYERS.map((s) => (
              <button
                key={s.id}
                className={`sat-chip${satId === s.id ? ' is-on' : ''}`}
                onClick={() => setSatId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <WorldMap place={place} onPick={setPlace} satId={satId} />

        {sat && sat.legend && <p className="sat-legend">{sat.legend}</p>}

        <div className="readout">
          <p className="live-place">
            {chosen ? (
              <>
                {place.name}
                {where && <span className="live-place-sub"> · {where}</span>}
                <span className="live-coords">
                  {fmt(place.lat, 3)}°, {fmt(place.lon, 3)}°
                </span>
              </>
            ) : (
              <span className="live-place-sub">
                No point selected yet — click the map or search above.
              </span>
            )}
          </p>

          {chosen && state === 'loading' && (
            <p className="live-status">Reading conditions at this point…</p>
          )}
          {chosen && state === 'error' && (
            <p className="live-status">
              Data is unavailable for this point right now. Try another point
              or retry in a moment.
            </p>
          )}

          {chosen && state === 'ok' && d && (
            <>
              <h3 className="group-head">Rainfall and water balance</h3>
              <div className="metrics">
                <div className="metric">
                  <span className="metric-value">{fmt(d.rainToday)}<em>mm</em></span>
                  <span className="metric-label">Rain today</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.rainNext7, 0)}<em>mm</em></span>
                  <span className="metric-label">Next 7 days</span>
                </div>
                <div className="metric">
                  <span className="metric-value">
                    {d.soil !== null ? fmt(d.soil, 2) : '—'}<em>m³/m³</em>
                  </span>
                  <span className="metric-label">Soil moisture 3–9 cm</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.et0)}<em>mm</em></span>
                  <span className="metric-label">Evapotranspiration ET₀</span>
                </div>
              </div>

              <RainChart
                dates={d.dates}
                rain={d.rain}
                past7={d.rainPast7}
                next7={d.rainNext7}
              />

              <h3 className="group-head">Rivers and terrain</h3>
              <div className="metrics">
                <div className="metric">
                  <span className="metric-value">{fmt(d.discharge, 2)}<em>m³/s</em></span>
                  <span className="metric-label">River discharge today</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.discharge30Max, 1)}<em>m³/s</em></span>
                  <span className="metric-label">30-day forecast peak</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.elevation, 0)}<em>m</em></span>
                  <span className="metric-label">Elevation</span>
                </div>
                <div className="metric">
                  <span className="metric-value">
                    {fmt(d.tmax, 0)}°<span className="metric-sub"> / {fmt(d.tmin, 0)}°</span>
                  </span>
                  <span className="metric-label">Max / min today</span>
                </div>
              </div>

              <h3 className="group-head">Air and climate outlook</h3>
              <div className="metrics">
                <div className="metric">
                  <span className="metric-value">{fmt(d.pm25, 0)}<em>µg/m³</em></span>
                  <span className="metric-label">PM2.5 now</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.pm10, 0)}<em>µg/m³</em></span>
                  <span className="metric-label">PM10 now</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.projTmax, 1)}°<em>C</em></span>
                  <span className="metric-label">Mean daily max, 2045 (CMIP6)</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{fmt(d.projPrecip, 0)}<em>mm</em></span>
                  <span className="metric-label">Annual rainfall, 2045 (CMIP6)</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="sources">
          <h3>Where this comes from</h3>
          <ul>
            <li>
              <strong>Weather, ET₀, soil moisture, elevation, climate projections</strong>
              <span>
                <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>{' '}
                — forecast, air-quality, elevation and CMIP6 climate APIs (CC-BY 4.0)
              </span>
            </li>
            <li>
              <strong>River discharge</strong>
              <span>Copernicus GloFAS global flood model, via the Open-Meteo Flood API</span>
            </li>
            <li>
              <strong>Satellite imagery</strong>
              <span>
                NASA{' '}
                <a href="https://worldview.earthdata.nasa.gov/" target="_blank" rel="noreferrer">GIBS / Worldview</a>{' '}
                — MODIS Terra, GPM IMERG (EOSDIS)
              </span>
            </li>
            <li>
              <strong>Place search and base map</strong>
              <span>Open-Meteo geocoding · © OpenStreetMap contributors, © CARTO</span>
            </li>
          </ul>
          <p className="live-note">
            These are global model and satellite products, shown for
            orientation and education. They are not official warnings, and
            they are coarse at local scale. For any decision, use the
            responsible national meteorological, hydrological or disaster
            management agency for the location in question.
          </p>
        </div>
      </div>
    </section>
  )
}

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

function App() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [asked, setAsked] = useState(false)

  async function ask(q) {
    const query = (q ?? question).trim()
    if (!query || loading) return
    setQuestion(query)
    setLoading(true)
    setResult(null)
    setError(null)
    setAsked(true)
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
    <>
      <nav className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <StrataMark />
            <span className="brand-name">WIM-Assistant</span>
          </span>
          <span className="topbar-links">
            <a className="topbar-link" href="#live">Observatory</a>
            <a className="topbar-link" href="#about">About WIM</a>
          </span>
        </div>
      </nav>

      <main className="main">
        <section className="hero">
          <p className="eyebrow">Water Intelligence Modeling · Intelligence layer</p>
          <h1>
            Water intelligence,
            <br />
            on demand.
          </h1>
          <p className="lede">
            Ask anything about water — fundamentals, engineering, governance.
            Every answer is grounded in a curated corpus and labelled by source.
            Ask in English, <span lang="hi">हिंदी</span>, or{' '}
            <span lang="kn">ಕನ್ನಡ</span>.
          </p>

          <div className="ask-box">
            <input
              type="text"
              value={question}
              placeholder="Ask a water question…"
              aria-label="Your question"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
            />
            <button className="ask-btn" onClick={() => ask()} disabled={loading}>
              {loading ? 'Consulting…' : 'Ask'}
            </button>
          </div>

          {!asked && (
            <div className="chips" aria-label="Example questions">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" onClick={() => ask(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="response" aria-live="polite">
          {loading && (
            <div className="answer-card loading-card">
              <div className="pulse-strata">
                <span /><span /><span /><span /><span />
              </div>
              <p className="loading-text">Searching the corpus and composing an answer…</p>
            </div>
          )}

          {error && (
            <div className="answer-card error-card">
              <p className="error-title">Something went wrong</p>
              <p className="error-text">{error}</p>
            </div>
          )}

          {result && (
            <article className="answer-card">
              <div className="badges">
                <span className={`badge ${tier.cls}`}>{tier.label}</span>
                {result.category === 'governance' && (
                  <span className="badge badge-gov">
                    Policy / legal — verify against the current official source
                  </span>
                )}
              </div>
              <p className="answer-text">{result.answer}</p>
              {result.source && (
                <p className="answer-source">
                  <StrataMark size={14} /> Source: {result.source}
                </p>
              )}
            </article>
          )}
        </section>
      </main>

      <Observatory />

      <section className="grading">
        <div className="grading-inner">
          <p className="eyebrow">Knowledge layer · provenance</p>
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
        </div>
      </section>

      <section className="loop">
        <div className="loop-inner">
          <p className="eyebrow">Intelligence layer · learning</p>
          <h2>How it learns</h2>
          <ol className="loop-steps">
            {LOOP_STEPS.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="about" className="about">
        <div className="about-inner">
          <h2>What is WIM?</h2>
          <p>
            Water Intelligence Modeling is a framework that integrates water
            data, engineering knowledge, environmental processes, and
            governance into a single evolving knowledge model — aiming to
            become for water what BIM became for buildings. WIM-Assistant is
            its intelligence layer: it explains, interprets regulations, and
            learns continuously. Questions it cannot yet answer are logged,
            reviewed by domain experts, and folded back into the corpus.
          </p>
          <ol className="layers" aria-label="The seven layers of WIM">
            {LAYERS.map((l, i) => (
              <li key={l} style={{ '--i': i }}>
                <span className="layer-bar" />
                {l}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="footer">
        <p>
          A Water Intelligence Modeling initiative · Answers are generated from
          a curated corpus and labelled by source tier. Policy and legal
          content should always be verified against current official sources.
        </p>
      </footer>
    </>
  )
}

export default App
