# apps/ios — RETIRED (2026-08-06)

**The app is `ios/Kyo`.** Founder ruling, 8/6: there is one app and it is the one Justin
pushed. TestFlight ships from `ios/testflight.sh`.

This directory is the earlier co prototype. It is kept for reference — its four-tab
charter (catches · taking shape · you should know · me), the pairing-by-wrapped-link
idea, and `RouterAPI.swift`'s DTOs all informed what Kyo now does — but **nothing here is
built, shipped, or maintained.** Do not add features to it.

What moved to Kyo:
- the whole rail client (`app.json` / `chat` / `lived`) → `ios/Kyo/Kyo/App/RailKyoAPI.swift`
- the lived-test surface (`Co/Views/LivedView.swift`) → `ios/Kyo/Kyo/Screens/InYourWeekSection.swift`

What did NOT move, and is worth reading before rebuilding it:
- the rooms/world tab (`Co/Views/RoomView.swift`) — Inside-Out, not a graph
- the today surface (`Co/Views/TodayView.swift`) — read, THE ONE THING, setup, then
