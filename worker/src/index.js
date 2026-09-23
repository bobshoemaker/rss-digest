// Poll news/deal feeds for Pokemon 30th Celebration UPC preorder news and push
// new matches to a phone via ntfy.sh. Runs on a Cloudflare cron trigger.

const UA = "Mozilla/5.0 (feed-digest)";
const SEEN_KEY = "seen";
const MAX_SEEN = 3000;

const QUERIES = [
  '"30th Celebration" "Ultra Premium Collection"',
  '"30th Celebration" UPC Pokemon Center preorder',
  '"Ultra Premium Collection" 30th anniversary Pokemon preorder',
  '"Pokemon Center" 30th anniversary "Ultra Premium Collection"',
  "Pokemon 30th anniversary UPC pre-order live",
];

// Deal/news accounts that post retailer links minutes after preorders open.
const BLUESKY_ACCOUNTS = ["wario64.bsky.social", "pokeguardian.bsky.social"];

const REDDIT_SUBS = ["PokemonTCG", "PKMNTCGDeals", "pokemontcgcollections"];

// An item must mention the product, the topic, AND a purchase signal to alert.
const PRODUCT_RE = /(ultra[\s-]*premium|\bUPC\b)/i;
const ANNIV_RE = /(30th|thirtieth|30 ?years?|celebration)/i;
const POKEMON_RE = /pok[eé]mon/i;
const BUY_RE = /(pre-?order|preorders?|live|in stock|restock|drop|available now|on sale)/i;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

// Returns {id, title, link} for RSS <item> or Atom <entry> elements.
function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    const title = tag(b, "title");
    const link = tag(b, "link") || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    return { id: tag(b, "guid") || tag(b, "id") || link || title, title, link: decode(link) };
  });
}

async function blueskyItems(handle) {
  const url =
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?" +
    new URLSearchParams({ actor: handle, limit: "30", filter: "posts_no_replies" });
  const data = JSON.parse(await fetchText(url));
  return (data.feed || []).map(({ post }) => ({
    id: post.uri,
    title: post.record.text || "",
    // Prefer the retailer link the post points to; fall back to the post itself.
    link:
      post.embed?.external?.uri ||
      `https://bsky.app/profile/${handle}/post/${post.uri.split("/").pop()}`,
  }));
}

function sources() {
  const feeds = QUERIES.map((q) => ({
    name: "Google News",
    topic: ANNIV_RE,
    load: async () =>
      parseFeed(
        await fetchText(
          "https://news.google.com/rss/search?" +
            new URLSearchParams({ q: `${q} when:7d`, hl: "en-US", gl: "US", ceid: "US:en" }),
        ),
      ),
  }));
  // Deal posts are terse and may omit "30th", so accept any Pokemon UPC drop there.
  for (const h of BLUESKY_ACCOUNTS) {
    feeds.push({ name: `@${h}`, topic: POKEMON_RE, load: () => blueskyItems(h) });
  }
  for (const sub of REDDIT_SUBS) {
    feeds.push({
      name: `r/${sub}`,
      topic: ANNIV_RE,
      load: async () =>
        parseFeed(
          await fetchText(
            `https://www.reddit.com/r/${sub}/search.rss?` +
              new URLSearchParams({
                q: 'UPC OR "ultra premium" 30th',
                restrict_sr: "1",
                sort: "new",
                t: "week",
              }),
          ),
        ),
    });
  }
  return feeds;
}

async function notify(env, { title, link }, source) {
  if (!env.NTFY_TOPIC) {
    console.log("NTFY_TOPIC not set; would notify:", title);
    return;
  }
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    body: `${title}\n(${source})`,
    headers: {
      Title: "Pokemon 30th UPC alert",
      Priority: "urgent",
      Tags: "rotating_light",
      Click: link,
    },
  });
}

async function run(env) {
  const stored = await env.STATE.get(SEEN_KEY, "json");
  const seen = new Set(stored || []);
  const firstRun = !stored;
  const before = seen.size;

  const feeds = sources();
  const results = await Promise.allSettled(feeds.map((f) => f.load()));

  let hits = 0;
  for (const [i, r] of results.entries()) {
    const { name, topic } = feeds[i];
    if (r.status === "rejected") {
      console.warn(`[warn] ${name}: ${r.reason?.message || r.reason}`);
      continue;
    }
    for (const item of r.value) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const t = item.title;
      if (PRODUCT_RE.test(t) && topic.test(t) && BUY_RE.test(t)) {
        hits++;
        console.log(`[match] ${name}: ${t} -> ${item.link}`);
        // Don't blast old articles on the very first run; just record them.
        if (!firstRun) await notify(env, item, name);
      }
    }
  }

  // Only write when something changed; KV free tier allows 1,000 writes/day.
  if (seen.size !== before || firstRun) {
    await env.STATE.put(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN)));
  }
  console.log(`done: ${hits} new matches, ${seen.size} seen`);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
