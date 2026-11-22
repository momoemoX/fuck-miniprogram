export interface MapView {
  latitude: number;
  longitude: number;
  scale: number;
}

export const DEFAULT_MAP_VIEW: Readonly<MapView> = { latitude: 39.92, longitude: 116.46, scale: 16 };
