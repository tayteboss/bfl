// Leaflet map with dynamic Shopify locations (fallbacks to hardcoded list) and nearest search

(function () {
  if (typeof window === 'undefined') return;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // Haversine distance in kilometers
  function haversineDistanceKm(a, b) {
    var toRad = function (deg) {
      return (deg * Math.PI) / 180;
    };
    var R = 6371; // km
    var dLat = toRad(b.lat - a.lat);
    var dLon = toRad(b.lng - a.lng);
    var lat1 = toRad(a.lat);
    var lat2 = toRad(b.lat);
    var sinDLat = Math.sin(dLat / 2);
    var sinDLon = Math.sin(dLon / 2);
    var aVal = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    var c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
    return R * c;
  }

  // Minimal geocoding using Nominatim (no key, rate-limited). Replace if needed.
  function geocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(query);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json();
    });
  }

  function toTelHref(phone) {
    if (!phone) return '';
    try {
      var digits = String(phone)
        .trim()
        .replace(/[^+\d]/g, '');
      return 'tel:' + digits;
    } catch (e) {
      return 'tel:' + phone;
    }
  }

  // Hardcoded sample USA locations (used if no CMS data found)
  // var DEFAULT_LOCATIONS = [
  //   { id: 'nyc', name: 'New York', lat: 40.7128, lng: -74.006 },
  //   { id: 'la', name: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
  //   { id: 'chi', name: 'Chicago', lat: 41.8781, lng: -87.6298 },
  //   { id: 'dal', name: 'Dallas', lat: 32.7767, lng: -96.797 },
  //   { id: 'den', name: 'Denver', lat: 39.7392, lng: -104.9903 },
  //   { id: 'sea', name: 'Seattle', lat: 47.6062, lng: -122.3321 },
  //   { id: 'mia', name: 'Miami', lat: 25.7617, lng: -80.1918 },
  //   { id: 'atl', name: 'Atlanta', lat: 33.749, lng: -84.388 },
  //   { id: 'phx', name: 'Phoenix', lat: 33.4484, lng: -112.074 },
  //   { id: 'bos', name: 'Boston', lat: 42.3601, lng: -71.0589 },
  // ];

  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');
  }

  function parseLocationsFromScriptEl(scriptEl) {
    try {
      var data = JSON.parse((scriptEl && scriptEl.textContent) || '[]');
      if (!Array.isArray(data)) return null;
      var cleaned = [];
      for (var i = 0; i < data.length; i++) {
        var raw = data[i] || {};
        var latNum = typeof raw.lat === 'number' ? raw.lat : parseFloat(raw.lat);
        var lngNum = typeof raw.lng === 'number' ? raw.lng : parseFloat(raw.lng);
        if (!isFinite(latNum) || !isFinite(lngNum)) continue;
        var idStr = raw.id && String(raw.id).trim().length ? String(raw.id).trim() : slugify(raw.name || 'loc-' + i);
        cleaned.push({
          id: idStr,
          name: raw.name || idStr,
          address: raw.address || '',
          lat: latNum,
          lng: lngNum,
          phone: raw.phone || '',
          website: raw.website || '',
          googleMapsUrl: raw.googleMapsUrl || raw.google_maps_url || '',
          thumbnail: raw.thumbnail || '',
        });
      }
      return cleaned;
    } catch (_e) {
      return null;
    }
  }

  function getLocationsFromScript(doc) {
    var d = doc || document;
    var el = d.getElementById('dropOffLocations');
    if (!el) return null;
    return parseLocationsFromScriptEl(el);
  }

  function fetchRemoteLocations() {
    var candidates = ['/pages/drop', '/pages/drop-off'];
    var tryNext = function (idx) {
      if (idx >= candidates.length) return Promise.resolve([]);
      var url = candidates[idx];
      return fetch(url, { credentials: 'same-origin' })
        .then(function (r) {
          return r.text();
        })
        .then(function (html) {
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var found = getLocationsFromScript(doc);
          if (found && found.length) return found;
          return tryNext(idx + 1);
        })
        .catch(function () {
          return tryNext(idx + 1);
        });
    };
    return tryNext(0);
  }

  ready(function () {
    var mapEl = document.getElementById('dropOffMap');
    if (!mapEl || typeof L === 'undefined') return;

    // Initialize map centered on continental US
    var map = L.map(mapEl, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
    // Default view so maps render even with no markers (e.g., homepage without blocks)
    var initialZoom = typeof window !== 'undefined' && window.innerWidth < 900 ? 10 : 5;
    map.setView([39.5, -98.35], initialZoom);

    // Tiles (OSM). You may replace with your preferred tile provider.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // Custom simple pin (yellow circle with black dot)
    var pinSize = 24;
    function makePinIcon(isActive) {
      var cls = 'dropoff-pin' + (isActive ? ' dropoff-pin--active' : '');
      return L.divIcon({
        className: cls,
        html: '<span class="dropoff-pin__dot"></span>',
        iconSize: [pinSize, pinSize],
        iconAnchor: [Math.round(pinSize / 2), Math.round(pinSize / 2)],
        popupAnchor: [0, -Math.round(pinSize / 2)],
      });
    }

    // Load locations (CMS local or fallback to remote Drop-off page)
    var LOCATIONS = [];

    function popupHtml(loc) {
      var html = '';
      html += '<div class="dropoff-popup">';
      html += '  <div class="dropoff-popup__content">';
      html += '    <div class="dropoff-popup__header">';
      html += '      <div class="dropoff-popup__title">' + String(loc.name || '') + '</div>';
      if (loc.address) {
        html += '      <div class="dropoff-popup__address">' + String(loc.address) + '</div>';
      }
      html += '    </div>';
      if (loc.website || loc.googleMapsUrl || loc.phone) {
        html += '    <div class="dropoff-popup__links">';
        if (loc.website) {
          html +=
            '      <a class="dropoff-popup__link dropoff-popup__link--website" href="' +
            String(loc.website) +
            '" target="_blank" rel="noopener">Website</a>';
        }
        if (loc.googleMapsUrl) {
          html +=
            '      <a class="dropoff-popup__link dropoff-popup__link--directions" href="' +
            String(loc.googleMapsUrl) +
            '" target="_blank" rel="noopener">Directions</a>';
        }
        if (loc.phone) {
          html +=
            '      <a class="dropoff-popup__link dropoff-popup__link--phone" href="' +
            toTelHref(loc.phone) +
            '">' +
            'Phone' +
            '</a>';
        }
        html += '    </div>';
      }
      html += '  </div>';
      if (loc.thumbnail) {
        html += '  <div class="dropoff-popup__media">';
        html +=
          '    <img class="dropoff-popup__image" src="' +
          String(loc.thumbnail) +
          '" alt="' +
          String(loc.name || '') +
          ' thumbnail" />';
        html += '  </div>';
      }
      html += '</div>';
      return html;
    }

    // Cluster group with custom cluster icon (yellow circle with count)
    var clusterGroup =
      typeof L.markerClusterGroup === 'function'
        ? L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyOnMaxZoom: true,
            zoomToBoundsOnClick: false,
            iconCreateFunction: function (cluster) {
              var childCount = cluster.getChildCount();
              return L.divIcon({
                html: String(childCount),
                className: 'dropoff-cluster',
                iconSize: null,
              });
            },
          })
        : null;

    // Prepare bottom-right overlay container for popups (replaces Leaflet popup)
    var mapInnerEl = mapEl.closest ? mapEl.closest('.drop-off-map__inner') : mapEl.parentElement;
    var overlayEl = document.createElement('div');
    overlayEl.className = 'dropoff-map-popup';
    if (mapInnerEl) mapInnerEl.appendChild(overlayEl);

    function renderOverlayForLocation(loc) {
      if (!overlayEl) return;
      overlayEl.innerHTML = popupHtml(loc);
      overlayEl.classList.add('is-visible');
    }

    function clearOverlay() {
      if (!overlayEl) return;
      overlayEl.classList.remove('is-visible');
      overlayEl.innerHTML = '';
    }

    function setActiveMarkerById(id) {
      for (var i = 0; i < markers.length; i++) {
        var mk = markers[i];
        var isActive = mk.loc && mk.loc.id === id;
        mk.setIcon(makePinIcon(isActive));
      }
    }

    var markers = [];

    function renderLocations() {
      // Clear previous
      if (clusterGroup) clusterGroup.clearLayers();
      for (var i = 0; i < markers.length; i++) {
        try {
          map.removeLayer(markers[i]);
        } catch (_e) {}
      }
      markers = [];
      // Add markers
      for (var j = 0; j < LOCATIONS.length; j++) {
        var loc = LOCATIONS[j];
        var m = L.marker([loc.lat, loc.lng], { icon: makePinIcon(false) });
        m.loc = loc; // attach
        m.on('click', function (ev) {
          var mk = ev.target;
          var l = mk.loc;
          setActiveMarkerById(l.id);
          renderOverlayForLocation(l);
        });
        if (clusterGroup) {
          clusterGroup.addLayer(m);
        } else {
          m.addTo(map);
        }
        markers.push(m);
      }

      // Fit map bounds to markers
      if (markers.length > 0) {
        var bounds = clusterGroup ? clusterGroup.getBounds() : L.featureGroup(markers).getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
          map.fitBounds(bounds.pad(0.2));
          // On mobile, ensure a minimum zoom so the map is more zoomed in
          if (typeof window !== 'undefined' && window.innerWidth < 900) {
            var minMobileZoom = 3;
            var currentZoom = map.getZoom();
            if (typeof currentZoom === 'number' && currentZoom < minMobileZoom) {
              var center = bounds.getCenter();
              map.setView(center, minMobileZoom);
            }
          }
        }
      }
    }

    if (clusterGroup) {
      map.addLayer(clusterGroup);
      // Ensure cluster click zooms to bounds (with padding) until target max zoom, then spiderfy
      var mapMaxZoom = typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : undefined;
      clusterGroup.on('clusterclick', function (e) {
        var targetMaxZoom = typeof mapMaxZoom === 'number' && isFinite(mapMaxZoom) ? Math.min(mapMaxZoom, 16) : 16;
        e.layer.zoomToBounds({ padding: [40, 40], maxZoom: targetMaxZoom });
      });
    }

    // Zoom controls wired to custom buttons
    var zoomInBtn = document.getElementById('zoomInBtn');
    var zoomOutBtn = document.getElementById('zoomOutBtn');
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', function () {
        map.zoomIn();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', function () {
        map.zoomOut();
      });
    }

    function findNearest(target) {
      var nearest = null;
      var nearestKm = Infinity;
      for (var i = 0; i < LOCATIONS.length; i++) {
        var loc = LOCATIONS[i];
        var dist = haversineDistanceKm({ lat: target.lat, lng: target.lng }, { lat: loc.lat, lng: loc.lng });
        if (dist < nearestKm) {
          nearest = loc;
          nearestKm = dist;
        }
      }
      return { loc: nearest, km: nearestKm };
    }

    function focusLocation(loc) {
      if (!loc) return;
      map.setView([loc.lat, loc.lng], 10);
      var marker = markers.find(function (m) {
        return m.loc.id === loc.id;
      });
      if (marker) {
        setActiveMarkerById(loc.id);
        if (clusterGroup && typeof clusterGroup.zoomToShowLayer === 'function') {
          clusterGroup.zoomToShowLayer(marker, function () {
            renderOverlayForLocation(loc);
          });
        } else {
          renderOverlayForLocation(loc);
        }
      }
    }

    // Search form
    var form = document.getElementById('locationSearchForm');
    var input = document.getElementById('locationSearchInput');
    if (form && input) {
      var submitBtn = form.querySelector('button[type="submit"]');
      function setSearchLoading(isLoading) {
        try {
          if (controlsEl) controlsEl.classList.toggle('drop-off-map__controls--loading', !!isLoading);
          form.classList.toggle('drop-off-map__search--loading', !!isLoading);
          input.disabled = !!isLoading;
          if (submitBtn) submitBtn.disabled = !!isLoading;
        } catch (_) {}
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = (input.value || '').trim();
        if (!q) return;
        setSearchLoading(true);
        geocode(q)
          .then(function (results) {
            if (!Array.isArray(results) || results.length === 0) return;
            var r = results[0];
            var target = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
            var nearest = findNearest(target);
            focusLocation(nearest.loc);
          })
          .catch(function () {
            /* silent */
          })
          .finally(function () {
            setSearchLoading(false);
          });
      });
    }

    // Geolocation
    var useMyLocationBtn = document.getElementById('useMyLocationBtn');
    if (useMyLocationBtn && 'geolocation' in navigator) {
      useMyLocationBtn.addEventListener('click', function () {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            var target = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            var nearest = findNearest(target);
            focusLocation(nearest.loc);
          },
          function () {
            /* silent */
          },
          { enableHighAccuracy: true, timeout: 8000 }
        );
      });
    }

    // Controls interactivity: shrink controls on map interaction, restore on search hover/focus
    var controlsEl = document.querySelector('.drop-off-map__controls');
    var searchFormEl = document.getElementById('locationSearchForm');
    var searchInputEl = document.getElementById('locationSearchInput');
    var hasUserInteracted = false;
    function setControlsInactive(isInactive) {
      if (!controlsEl) return;
      if (isInactive) {
        controlsEl.classList.add('drop-off-map__controls--inactive');
      } else {
        controlsEl.classList.remove('drop-off-map__controls--inactive');
      }
    }

    if (controlsEl) {
      // Only set inactive after user interacts with the map
      map.on('movestart', function () {
        if (hasUserInteracted) setControlsInactive(true);
      });
      map.on('zoomstart', function () {
        if (hasUserInteracted) setControlsInactive(true);
      });
      map.on('dragstart', function () {
        if (hasUserInteracted) setControlsInactive(true);
      });
      // Direct interactions mark as user-interacted and collapse
      mapEl.addEventListener('mousedown', function () {
        hasUserInteracted = true;
        setControlsInactive(true);
      });
      mapEl.addEventListener(
        'touchstart',
        function () {
          hasUserInteracted = true;
          setControlsInactive(true);
        },
        { passive: true }
      );
      mapEl.addEventListener(
        'wheel',
        function () {
          hasUserInteracted = true;
          setControlsInactive(true);
        },
        { passive: true }
      );
    }

    // Only the INPUT should restore controls (not the whole form/container)
    if (searchInputEl) {
      searchInputEl.addEventListener('mouseenter', function () {
        setControlsInactive(false);
      });
      // Do not collapse on leaving the form; only after next map interaction
      searchInputEl.addEventListener('focusin', function () {
        setControlsInactive(false);
      });
      // Do not collapse on blur; only after next map interaction
    }

    // Load local or remote locations then render
    var local = getLocationsFromScript();
    if (local && local.length) {
      LOCATIONS = local;
      renderLocations();
    } else {
      fetchRemoteLocations().then(function (remote) {
        if (Array.isArray(remote) && remote.length) {
          LOCATIONS = remote;
          renderLocations();
        }
      });
    }

    // Hide overlay when clicking empty map area
    map.on('click', function (e) {
      var t = e.originalEvent && e.originalEvent.target;
      var inMarker = t && t.closest && t.closest('.leaflet-marker-icon');
      var inOverlay = t && t.closest && t.closest('.dropoff-map-popup');
      if (!inMarker && !inOverlay) {
        clearOverlay();
        setActiveMarkerById(null);
      }
    });
  });
})();
