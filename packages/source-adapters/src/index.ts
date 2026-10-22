export {
  buildCanonicalEventKey,
  canonicalUrl,
  normalizeTitle,
  timeWindowBucket,
  type AdapterType,
  type SourceAdapter,
  type SubscriptionState,
  type WatchEntityRef,
  type PolledEvent,
  type PollResult,
} from "./adapter";
export { parseFeed, pollFeed, makeRssAdapter, type FeedItem, type ParsedFeed, type PollFeedOptions } from "./rss";
export { searchPodcasts, resolveFeedUrl, makePodcastAdapter, type PodcastCatalogEntry } from "./podcast";
export { compileRadarQuery, type RadarQueryInput, type CompiledSearchQuery } from "./websearch";
export { pollSite, makeSiteMonitorAdapter, type PollSiteOptions } from "./sitemonitor";
export { makeXAdapter, FeatureDisabledError } from "./x";

// merged 2026-07-27: codex modules pulled into this package need exporting too.
export * from "./apple-podcasts";
export * from "./article";
export * from "./http";
export * from "./http-change";
export * from "./safe-url";
export * from "./search-query";
export * from "./types";

// codex's class-based adapters, kept under distinct filenames because both trees implemented
// RSS/X and both are load-bearing: mine (parseFeed/pollFeed) drive trigger/radar-poll, codex's
// (RSSAdapter/XSourceAdapter) drive its apple-podcasts and article adapters.
export { RSSAdapter } from "./rss-adapter";
export { XSourceAdapter } from "./x-adapter";
