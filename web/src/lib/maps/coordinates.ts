/**
 * Coordinate model shared with the ForeverDB Companion (MapPreviewControl.PlaceCentered):
 *   pixelX = imageWidth  * xPercent / 100
 *   pixelY = imageHeight * yPercent / 100          (origin top-left, Y grows downward)
 * Leaflet CRS.Simple has Y growing upward, so with image bounds [[0,0],[H,W]]:
 *   lat = H * (1 - yPercent / 100),  lng = W * xPercent / 100        (LatLng order is [lat, lng] = [y, x])
 */

export interface MapSize { width: number; height: number }
export type LatLngTuple = [lat: number, lng: number];

export function isValidPercent(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
}

/** Companion pixel position (top-left origin). Returns null for out-of-range input; never clamps. */
export function percentToPixel(size: MapSize, x: number, y: number): { px: number; py: number } | null {
  return isValidPercent(x, y) ? { px: (size.width * x) / 100, py: (size.height * y) / 100 } : null;
}

export function percentToLatLng(size: MapSize, x: number, y: number): LatLngTuple | null {
  return isValidPercent(x, y) ? [size.height * (1 - y / 100), (size.width * x) / 100] : null;
}

export function latLngToPercent(size: MapSize, lat: number, lng: number): { x: number; y: number } {
  return { x: (lng / size.width) * 100, y: (1 - lat / size.height) * 100 };
}

/** Leaflet image bounds for the whole map surface. */
export function imageBounds(size: MapSize): [LatLngTuple, LatLngTuple] {
  return [[0, 0], [size.height, size.width]];
}
