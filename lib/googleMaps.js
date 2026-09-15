'use strict';

/**
 * lib/googleMaps.js — Distance Matrix & Geocoding via Google Maps API or OpenStreetMap fallback
 * 
 * Computes shortest driving distance between origin and destination locations.
 * Uses GOOGLE_MAPS_API_KEY if present, otherwise uses free OpenStreetMap OSRM API.
 */

async function calculateDrivingDistance(origin, destination) {
  if (!origin || !destination) return null;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  // 1. If Google Maps API key exists, call Google Maps Distance Matrix API
  if (apiKey && apiKey !== 'your_google_maps_api_key_here') {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.status === 'OK' && data.rows?.[0]?.elements?.[0]?.status === 'OK') {
        const distanceMeters = data.rows[0].elements[0].distance.value;
        const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
        return {
          distance_km: distanceKm,
          source: 'Google Maps API',
          origin_address: data.origin_addresses?.[0] || origin,
          destination_address: data.destination_addresses?.[0] || destination
        };
      }
    } catch (err) {
      console.warn('[GoogleMaps] Distance Matrix API call failed:', err.message);
    }
  }

  // 2. OpenStreetMap / OSRM Geocoding + Routing Fallback (Free, zero config)
  try {
    const geoUrl = (q) => `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    const [origRes, destRes] = await Promise.all([
      fetch(geoUrl(origin), { headers: { 'User-Agent': 'StaffHub-HRMS/1.0' } }),
      fetch(geoUrl(destination), { headers: { 'User-Agent': 'StaffHub-HRMS/1.0' } })
    ]);

    const origData = await origRes.json();
    const destData = await destRes.json();

    if (origData.length > 0 && destData.length > 0) {
      const origLat = parseFloat(origData[0].lat);
      const origLon = parseFloat(origData[0].lon);
      const destLat = parseFloat(destData[0].lat);
      const destLon = parseFloat(destData[0].lon);

      // Call OSRM driving route API
      const routeUrl = `http://router.project-osrm.org/route/v1/driving/${origLon},${origLat};${destLon},${destLat}?overview=false`;
      const routeRes = await fetch(routeUrl);
      const routeData = await routeRes.json();

      if (routeData.code === 'Ok' && routeData.routes?.[0]) {
        const distanceKm = Math.round((routeData.routes[0].distance / 1000) * 10) / 10;
        return {
          distance_km: distanceKm,
          source: 'OpenStreetMap Routing',
          origin_address: origData[0].display_name,
          destination_address: destData[0].display_name
        };
      }
    }
  } catch (err) {
    console.warn('[OpenStreetMap] Routing fallback failed:', err.message);
  }

  return null;
}

module.exports = {
  calculateDrivingDistance
};
