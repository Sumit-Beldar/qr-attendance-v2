'use strict';

/**
 * Calculate great-circle distance between two points on Earth using Haversine formula
 * Returns distance in meters.
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's mean radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Validate student location against classroom settings
 *
 * @param {Object} studentLoc - { lat, lng, accuracy, locationError }
 * @param {Object} classroom - { mode: 'off'|'flag'|'block', lat, lng, radius }
 * @returns {Object} { allowed: boolean, flagged: boolean, reason?: string, error?: string, distance?: number }
 */
function validateLocation(studentLoc, classroom) {
  const mode = (classroom.mode || 'flag').toLowerCase();

  // If location check is turned off or classroom location has not been configured
  if (mode === 'off' || !classroom.lat || !classroom.lng) {
    return { allowed: true, flagged: false };
  }

  const radius = Number(classroom.radius) || 150;
  const classLat = parseFloat(classroom.lat);
  const classLng = parseFloat(classroom.lng);

  if (isNaN(classLat) || isNaN(classLng)) {
    return { allowed: true, flagged: false };
  }

  // Handle location error (denied, timed out, unavailable)
  if (studentLoc.locationError || studentLoc.lat === undefined || studentLoc.lat === null || isNaN(parseFloat(studentLoc.lat))) {
    if (mode === 'block') {
      return {
        allowed: false,
        error: 'Location permission is required to mark attendance in this class. Please enable GPS / location permissions in your browser.',
      };
    }
    // Flag only mode
    return {
      allowed: true,
      flagged: true,
      reason: 'Location not shared',
    };
  }

  const stuLat = parseFloat(studentLoc.lat);
  const stuLng = parseFloat(studentLoc.lng);
  const accuracy = Math.max(0, parseFloat(studentLoc.accuracy) || 0);

  const rawDistance = haversineDistanceMeters(stuLat, stuLng, classLat, classLng);
  // Haversine distance accounting for GPS uncertainty
  const effectiveDistance = rawDistance - accuracy;

  if (effectiveDistance > radius) {
    const distDisplay =
      rawDistance >= 1000
        ? `≈ ${(rawDistance / 1000).toFixed(1)} km`
        : `≈ ${Math.round(rawDistance)} m`;

    if (mode === 'block') {
      return {
        allowed: false,
        error: `Location check failed: You appear to be outside the classroom (${distDisplay} away, allowed radius: ${radius}m).`,
      };
    }

    // Flag only mode
    return {
      allowed: true,
      flagged: true,
      reason: `Outside classroom (${distDisplay})`,
      distance: rawDistance,
    };
  }

  return {
    allowed: true,
    flagged: false,
    distance: rawDistance,
  };
}

module.exports = {
  haversineDistanceMeters,
  validateLocation,
};
