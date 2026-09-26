import { mapsApi } from '../api/client'
import { decisionApi } from '../api/decision'
import { placeRepo } from './placeRepo'
import type {
  AddDecisionCandidateRequest,
  DecisionCandidate,
  DecisionCandidateEvidence,
  DecisionCandidateFacts,
  MapsAutocompleteSuggestion,
} from '@trek/shared'
import type { Place } from '../types'

/**
 * TREK-place search for the decision room (M2-02/03) — online-only by design.
 *
 * The flow is suggest → details (+ photo) → persist a Place on the session's
 * technical trip → pin it as a candidate, so the whole group decides on real
 * venues instead of hand-typed rows. Nothing here touches Dexie: candidates
 * reach the store via the decision:candidate-added broadcast like any other
 * write.
 */

/** A maps-autocomplete row — alias so call sites don't reach for the maps domain name. */
export type VenueSuggestion = MapsAutocompleteSuggestion

/** Provider details blob, normalised to the fields the pick flow needs. */
export interface VenuePick {
  placeId: string
  name: string
  address: string | null
  lat: number | null
  lng: number | null
  osm_id: string | null
  google_place_id: string | null
  google_ftid: string | null
  amap_poi_id: string | null
  vietmap_ref_id: string | null
  website: string | null
  phone: string | null
  rating: number | null
  rating_count: number | null
  open_now: boolean | null
  opening_weekdays: string[] | null
  opening_periods: { open: { day: number; hour: number; minute: number }; close: { day: number; hour: number; minute: number } | null }[] | null
  opening_special_days: string[] | null
  facts: DecisionCandidateFacts | null
  google_maps_url: string | null
  summary: string | null
  source: string
  /** TREK photo-proxy URL (/api/maps/place-photo/.../bytes) — stable, cacheable. */
  photo_url: string | null
  photo_attribution: string | null
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null

const isPeriod = (v: unknown): v is { open: { day: number; hour: number; minute: number }; close: { day: number; hour: number; minute: number } | null } => {
  if (typeof v !== 'object' || v === null) return false
  const p = v as { open?: { day?: unknown; hour?: unknown; minute?: unknown }; close?: unknown }
  const o = p.open
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.day === 'number' &&
    typeof o.hour === 'number' &&
    typeof o.minute === 'number'
  )
}
const asPeriods = (v: unknown): VenuePick['opening_periods'] =>
  Array.isArray(v) && v.every(isPeriod) ? v : null

const asFacts = (d: Record<string, unknown>): DecisionCandidateFacts | null => {
  const facts: DecisionCandidateFacts = {
    cuisine: asString(d.cuisine),
    menu_url: asString(d.menu_url),
    outdoor_seating: asString(d.outdoor_seating),
    takeaway: asString(d.takeaway),
    delivery: asString(d.delivery),
    wheelchair: asString(d.wheelchair),
    vegetarian: asString(d.diet_vegetarian),
    vegan: asString(d.diet_vegan),
    internet_access: asString(d.internet_access),
  }
  return Object.values(facts).some(v => v != null) ? facts : null
}

export const decisionPlacesRepo = {
  /** Autocomplete rows for the venue search box. Online only — caller debounces. */
  search(input: string, signal?: AbortSignal) {
    return mapsApi.autocomplete(input, 'vi', undefined, signal)
  },

  /**
   * Details + photo for one picked suggestion. Photo is best-effort: a missing
   * photo never blocks adding the venue (the endpoint already returns
   * `{photoUrl: null}` for every miss kind).
   */
  async load(suggestion: VenueSuggestion): Promise<VenuePick | null> {
    const [detailsRes, photoRes] = await Promise.all([
      mapsApi.details(suggestion.placeId, 'vi'),
      mapsApi.placePhoto(suggestion.placeId, suggestion.lat, suggestion.lng, suggestion.mainText).catch(() => null),
    ])
    const d = detailsRes?.place
    if (!d || typeof d !== 'object') return null
    const blob = d as Record<string, unknown>
    const pick: VenuePick = {
      placeId: suggestion.placeId,
      name: asString(blob.name) ?? suggestion.mainText,
      address: asString(blob.address) ?? suggestion.secondaryText ?? null,
      lat: asNumber(blob.lat) ?? suggestion.lat ?? null,
      lng: asNumber(blob.lng) ?? suggestion.lng ?? null,
      osm_id: asString(blob.osm_id),
      google_place_id: asString(blob.google_place_id),
      google_ftid: asString(blob.google_ftid),
      amap_poi_id: asString(blob.amap_poi_id),
      vietmap_ref_id: asString(blob.vietmap_ref_id),
      website: asString(blob.website),
      phone: asString(blob.phone),
      rating: asNumber(blob.rating),
      rating_count: asNumber(blob.rating_count),
      open_now: asBoolean(blob.open_now),
      opening_weekdays: asStringArray(blob.opening_hours),
      opening_periods: asPeriods(blob.opening_periods),
      opening_special_days: asStringArray(blob.opening_special_days),
      facts: asFacts(blob),
      google_maps_url: asString(blob.google_maps_url),
      summary: asString(blob.summary),
      source: asString(blob.source) ?? 'trek-places',
      photo_url: photoRes?.photoUrl ?? null,
      photo_attribution: photoRes?.attribution ?? null,
    }
    return pick
  },

  /**
   * Persist the pick: Place on the session's technical trip (provider ids +
   * website/phone/image_url travel with the row), then pin it as a candidate
   * with the evidence the place columns can't hold.
   */
  async addCandidate(
    sessionId: number,
    tripId: number | string,
    pick: VenuePick,
  ): Promise<{ place: Place; candidate: DecisionCandidate }> {
    const { place } = await placeRepo.create(tripId, {
      name: pick.name,
      ...(pick.lat != null && pick.lng != null ? { lat: pick.lat, lng: pick.lng } : {}),
      ...(pick.address ? { address: pick.address } : {}),
      ...(pick.osm_id ? { osm_id: pick.osm_id } : {}),
      ...(pick.google_place_id ? { google_place_id: pick.google_place_id } : {}),
      ...(pick.google_ftid ? { google_ftid: pick.google_ftid } : {}),
      ...(pick.amap_poi_id ? { amap_poi_id: pick.amap_poi_id } : {}),
      ...(pick.website ? { website: pick.website } : {}),
      ...(pick.phone ? { phone: pick.phone } : {}),
      ...(pick.photo_url ? { image_url: pick.photo_url } : {}),
      ...(pick.summary ? { description: pick.summary } : {}),
    })
    const evidence: DecisionCandidateEvidence = {
      source: pick.source,
      retrieved_at: new Date().toISOString(),
      rating: pick.rating,
      rating_count: pick.rating_count,
      open_now: pick.open_now,
      opening_weekdays: pick.opening_weekdays,
      opening_periods: pick.opening_periods,
      opening_special_days: pick.opening_special_days,
      facts: pick.facts,
      google_maps_url: pick.google_maps_url,
      vietmap_ref_id: pick.vietmap_ref_id,
    }
    const body: AddDecisionCandidateRequest = { place_id: place.id, evidence }
    const { candidate } = await decisionApi.addCandidate(sessionId, body)
    return { place, candidate }
  },

  /**
   * Provider id a pick or candidate carries — the dedup key. The same café can
   * arrive twice via different suggestion rows; ids don't.
   */
  providerIdOf(pick: Pick<VenuePick, 'google_place_id' | 'osm_id' | 'amap_poi_id' | 'vietmap_ref_id'>): string | null {
    return pick.google_place_id ?? pick.osm_id ?? pick.amap_poi_id ?? pick.vietmap_ref_id
  },
}
