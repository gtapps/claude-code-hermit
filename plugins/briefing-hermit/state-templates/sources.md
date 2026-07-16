# Sources

Configure your sources below. The `Type` column tells the hermit how to fetch each source.

## Source Types

| Type          | Tool     | Needs Chrome | Description                                                        |
| ------------- | -------- | ------------ | ------------------------------------------------------------------ |
| `web`         | WebFetch | No           | Blogs, news sites, static pages                                    |
| `rss`         | WebFetch | No           | RSS/Atom feeds (tip: Reddit subreddits have RSS at `/r/NAME/.rss`) |
| `chrome`      | Chrome   | Yes          | Any web page that blocks WebFetch (403/bot detection)              |
| `reddit`      | Chrome   | Yes          | Reddit subreddit — logged-in view with votes and comments          |
| `reddit-home` | Chrome   | Yes          | Your Reddit front page — personalized subscribed feed              |
| `x`           | Chrome   | Yes          | X/Twitter account, timeline, or search                             |

Chrome sources use your browser sessions — if you're logged into Reddit/X in Chrome, the hermit reads your personalized feeds. If Chrome isn't connected, these sources are skipped and you'll see a note in your briefing.

The `reddit` type also tries the bundled `scripts/reddit-fetch.ts` (unauthenticated JSON API) before falling back to Chrome — see [`docs/reddit.md`](../claude-code-hermit/docs/reddit.md) if that file resolves in your install, or the plugin's own `docs/reddit.md`.

## Active Sources

| Name | URL | Category | Type | Notes |
| ---- | --- | -------- | ---- | ----- |

<!-- Add sources with /briefing-hermit:add-source, or edit this table directly.
     Every row's Category must exist in categories.md; every Type must be one of the types above.
     The validate-sources hook checks this table on save. -->
