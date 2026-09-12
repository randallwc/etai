RIVE -- the agent visual
========================

AgentSurface renders frontend/public/map-pin-marker.riv through
@rive-app/react-canvas (pinned 4.34.1; 4.34.2 shipped <7 days before we
adopted it). The file is teroy's "Map Pin Marker" from the Rive
marketplace, vendored from
public.rive.app/community/runtime-files/21134-39721-map-pin-marker.riv
(2.9 KB) so the app never depends on their CDN at demo time. Marketplace
file pages embed their runtime-file URL in the page HTML -- grep for
public.rive.app to extract it.

State machine "markerpin" exposes one boolean input, `isSelecting`:
false sits as a flat map marker, true rises into the push pin -- the
same pin as docs/logo/etai-c-pin.svg. The component binds `speaking`
straight onto it, so the pin lifts while the agent talks and settles
when it stops. Input names were discovered by enumerating the file with
@rive-app/canvas-advanced-single in node -- strings(1) does not reveal
them for newer .riv files.

Gotchas: files on cdn.rive.app/animations are hit-or-miss (several 403,
flux_capacitor.riv is format 6.3 vs runtime 7.4 and silently fails).
The orb stays mounted behind the canvas as the load/offline fallback.

Upgrade path: author a real etAI pin in the Rive editor (route line
draws, dot travels, radar rings) exporting a `speaking` boolean input,
drop the .riv into public/, and swap src/stateMachines in AgentSurface
-- the props seam does not change.
