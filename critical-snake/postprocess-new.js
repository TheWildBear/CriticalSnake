(function(CriticalSnake) {

function back(array) {
  return array.length > 0 ? array[array.length - 1] : null;
}

function initialCoordBounds() {
  return {
    min: [90.0, 180.0],
    max: [-90.0, -180.0],
    center: []
  };
}

CriticalSnake.PostProcessor = function(options) {

  const self = this;

  function importApiVersion2DataPoint(dataPoint) {
    const floatCoord = (oldFormat) => {
      let chars = oldFormat.toString().split('');
      chars.splice(-6, 0, '.');
      return parseFloat(chars.join(''));
    };
    return {
      stamp: new Date(dataPoint.timestamp * 1000),
      lat: floatCoord(dataPoint.latitude),
      lng: floatCoord(dataPoint.longitude)
    };
  }

  function splitTrack(vector) {
    if (vector.duration > options.trackRestrictions.maxGapDuration) {
      return true;
    }
    if (vector.distance > options.trackRestrictions.maxGapDistance) {
      return true;
    }
    return false;
  }

  // Use simple integers as track IDs.
  function hashToIdx(hash) {
    if (!self.indexMap.hasOwnProperty(hash)) {
      // For split-tracks we can have multiple indexes for one participant.
      self.indexMap[hash] = [ self.nextIndex++ ];
    }
    // Latest track-index for the participant.
    return back(self.indexMap[hash]);
  }

  function newIdxForHash(hash) {
    if (!self.indexMap.hasOwnProperty(hash)) {
      console.error("Invalid use of newIdxForHash()");
    }
    self.indexMap[hash].push(self.nextIndex++);
    return back(self.indexMap[hash]);
  }

  function directionAngleRadians(c1, c2) {
    const norm = (lat) => Math.tan((lat / 2) + (Math.PI / 4));
    const Δφ = Math.log(norm(c2.lat) / norm(c1.lat));
    const Δlon = Math.abs(c1.lng - c2.lng);
    return Math.atan2(Δlon, Δφ);
  }

  function haversineMeters(c1, c2) {
    const R = 6371e3; // metres
    const φ1 = c1.lat * Math.PI / 180; // φ, λ in radians
    const φ2 = c2.lat * Math.PI / 180;
    const Δφ = (c2.lat - c1.lat) * Math.PI / 180;
    const Δλ = (c2.lng - c1.lng) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  // The vector is the transition info between the last and the current
  // data-point in the track.
  function calculateVector(latest, next) {
    if (latest.stamp == next.stamp) {
      self.filteredDupes += 1;
      return null;
    }

    // TODO: We should record a min/max timestamp here.
    if (latest.lat == next.lat && latest.lng == next.lng) {
      self.filteredDupes += 1;
      return null;
    }

    if (latest.stamp > next.stamp) {
      console.error("Invalid dataset ordering: timestamp", latest.stamp,
                    "> timestamp", next.stamp);
      return null;
    }

    const radians = directionAngleRadians(latest, next);
    if (radians < 0 || radians > 2 * Math.PI || isNaN(radians)) {
      console.warn("Dropping data-point due to invalid direction",
                  radians, " (radians) from", latest, "to", next);
      return null;
    }

    const meters = haversineMeters(latest, next);
    if (meters <= 0) {
      console.warn("Dropping data-point due to invalid distance",
                  meters, "(meters) from", latest, "to", next);
      return null;
    }

    const seconds = (next.stamp - latest.stamp) / 1000;
    if (seconds < 0) {
      console.warn("Dropping data-point due to invalid duration",
                  seconds, " (seconds) from", latest, "to", next);
      return null;
    }

    return {
      direction: radians,
      distance: meters,
      duration: seconds
    }
  }

  function totalDistance(track) {
    const addDists = (sum, t) => t.vector ? sum + t.vector.distance : sum;
    return track.reduce(addDists, 0);
  }

  function totalTime(track) {
    const addDurations = (sum, t) => t.vector ? sum + t.vector.duration : sum;
    return track.reduce(addDurations, 0);
  }

  this.run = (dataset) => {

    // Dataset pass: populate tracks
    for (const snapshot in dataset) {
      for (const participant in dataset[snapshot]) {
        const dataPoint = importApiVersion2DataPoint(dataset[snapshot][participant]);

        if (!options.coordFilter([ dataPoint.lat, dataPoint.lng ])) {
          self.filteredOutOfRange += 1;
          continue;
        }

        const idx = hashToIdx(participant);
        if (self.tracks.length <= idx) {
          self.tracks[idx] = [ dataPoint ];
          continue;
        }

        const latest = back(self.tracks[idx]);
        const vector = calculateVector(latest, dataPoint);

        if (vector) {
          if (splitTrack(vector)) {
            // Drop the vector and create a new track for this data-point.
            const idx = newIdxForHash(participant);
            self.tracks[idx] = [ dataPoint ];
          }
          else {
            // Add vector to the latest data-point in the track and push the new
            // data-point on top.
            latest.vector = vector;
            self.tracks[idx].push(dataPoint);
          }
        }
      }
    }

    self.tracks = self.tracks.filter(track => {
      if (track.length < options.trackRestrictions.minDataPoints)
        return false;
      if (totalDistance(track) < options.trackRestrictions.minTotalDistance)
        return false;
      if (totalTime(track) < options.trackRestrictions.minTotalDuration)
        return false;
      return true;
    });

    let minEpoch = 8640000000000;
    let maxEpoch = 0;
    for (const track of self.tracks) {
      minEpoch = Math.min(minEpoch, track[0].stamp.getTime() / 1000);
      maxEpoch = Math.max(maxEpoch, back(track).stamp.getTime() / 1000);
    }

    return {
      origin: [52.5, 13.4],
      snakeBounds: initialCoordBounds(),
      timeRange: [ new Date(minEpoch * 1000), new Date(maxEpoch * 1000)],
      frames: [{
        coord: [52.51, 13.41],
        snake: null
      }]
    };
  }; // CriticalSnake.PostProcessor.run()

  this.tracks = [];
  this.indexMap = {};
  this.nextIndex = 0;
  this.filteredDupes = 0;
  this.filteredOutOfRange = 0;

}; // CriticalSnake.PostProcessor

})(window.CriticalSnake = window.CriticalSnake || {});
