import { describe, expect, it, vi, beforeEach } from 'vitest'
import { decisionPlacesRepo } from './decisionPlaces'
import type { VenuePick } from './decisionPlaces'

// FE-REPO-DECPLACE-001..004 — the search→candidate orchestration is mocked at
// its three seams (mapsApi, placeRepo, decisionApi): what is being tested is
// the normalisation and the evidence body, not the network.
const details = vi.fn()
const placePhoto = vi.fn()
const autocomplete = vi.fn()
const create = vi.fn()
const addCandidate = vi.fn()

vi.mock('../api/client', () => ({
  mapsApi: {
    details: (...args: unknown[]) => details(...args),
    placePhoto: (...args: unknown[]) => placePhoto(...args),
    autocomplete: (...args: unknown[]) => autocomplete(...args),
  },
}))
vi.mock('./placeRepo', () => ({
  placeRepo: { create: (...args: unknown[]) => create(...args) },
}))
vi.mock('../api/decision', () => ({
  decisionApi: { addCandidate: (...args: unknown[]) => addCandidate(...args) },
}))

const suggestion = {
  placeId: 'node:9712313',
  mainText: 'Cà phê Vợt',
  secondaryText: 'Đặng Văn Ngữ, Đống Đa',
  lat: 21.01,
  lng: 105.83,
  source: 'trek-places',
}

const detailsBlob = {
  name: 'Cà phê Vợt',
  address: '13 Đặng Văn Ngữ',
  lat: 21.01,
  lng: 105.83,
  osm_id: 'node:9712313',
  website: 'https://caphevot.vn',
  phone: '0901234567',
  rating: 4.5,
  rating_count: 812,
  open_now: true,
  opening_hours: ['Monday: 07:00–22:00'],
  opening_periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
  cuisine: 'coffee_shop',
  internet_access: 'yes',
  menu_url: 'https://caphevot.vn/menu',
  source: 'openstreetmap',
}

describe('decisionPlacesRepo.load', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('normalises the details blob + photo into a pick (FE-REPO-DECPLACE-001)', async () => {
    details.mockResolvedValue({ place: detailsBlob })
    placePhoto.mockResolvedValue({ photoUrl: '/api/maps/place-photo/x/bytes', attribution: 'OSM' })
    const pick = await decisionPlacesRepo.load(suggestion)
    expect(pick).not.toBeNull()
    expect(pick!.name).toBe('Cà phê Vợt')
    expect(pick!.osm_id).toBe('node:9712313')
    expect(pick!.rating).toBe(4.5)
    expect(pick!.rating_count).toBe(812)
    expect(pick!.opening_periods?.[0]?.open.hour).toBe(7)
    expect(pick!.facts?.internet_access).toBe('yes')
    expect(pick!.photo_url).toBe('/api/maps/place-photo/x/bytes')
    expect(pick!.source).toBe('openstreetmap')
  })

  it('a photo miss never blocks the pick (FE-REPO-DECPLACE-002)', async () => {
    details.mockResolvedValue({ place: detailsBlob })
    placePhoto.mockResolvedValue({ photoUrl: null, attribution: null })
    const pick = await decisionPlacesRepo.load(suggestion)
    expect(pick!.photo_url).toBeNull()
    expect(pick!.name).toBe('Cà phê Vợt')
  })

  it('returns null when the details lookup comes back empty', async () => {
    details.mockResolvedValue({ place: null })
    placePhoto.mockResolvedValue({ photoUrl: null, attribution: null })
    expect(await decisionPlacesRepo.load(suggestion)).toBeNull()
  })
})

describe('decisionPlacesRepo.addCandidate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const pick: VenuePick = {
    placeId: 'node:9712313',
    name: 'Cà phê Vợt',
    address: '13 Đặng Văn Ngữ',
    lat: 21.01,
    lng: 105.83,
    osm_id: 'node:9712313',
    google_place_id: null,
    google_ftid: null,
    amap_poi_id: null,
    website: 'https://caphevot.vn',
    phone: '0901234567',
    rating: 4.5,
    rating_count: 812,
    open_now: true,
    opening_weekdays: ['Monday: 07:00–22:00'],
    opening_periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
    opening_special_days: null,
    facts: { cuisine: 'coffee_shop', internet_access: 'yes' },
    google_maps_url: null,
    summary: null,
    source: 'openstreetmap',
    photo_url: '/api/maps/place-photo/x/bytes',
    photo_attribution: 'OSM',
  }

  it('persists provider ids on the Place and passes evidence to addCandidate (FE-REPO-DECPLACE-003)', async () => {
    create.mockResolvedValue({ place: { id: 77 } })
    addCandidate.mockResolvedValue({ candidate: { id: 9 } })
    const r = await decisionPlacesRepo.addCandidate(5, 11, pick)
    expect(create).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        name: 'Cà phê Vợt',
        lat: 21.01,
        osm_id: 'node:9712313',
        website: 'https://caphevot.vn',
        phone: '0901234567',
        image_url: '/api/maps/place-photo/x/bytes',
      }),
    )
    expect(addCandidate).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        place_id: 77,
        evidence: expect.objectContaining({
          source: 'openstreetmap',
          rating: 4.5,
          rating_count: 812,
          open_now: true,
          opening_periods: pick.opening_periods,
          facts: pick.facts,
        }),
      }),
    )
    expect(r.candidate.id).toBe(9)
  })
})
