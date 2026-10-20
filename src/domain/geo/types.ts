/** WGS84 position as `[longitude, latitude]` in decimal degrees (GeoJSON order). */
export type LngLat = readonly [lng: number, lat: number];

/** A polyline with cumulative along-track distances, `cumulative[0] === 0`. */
export interface MeasuredLine {
  readonly points: readonly LngLat[];
  /** Metres from the first point to `points[i]`. Non-decreasing. */
  readonly cumulative: readonly number[];
  readonly length: number;
}
