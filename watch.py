"""Poll news/community feeds for Pokemon Center 30th anniversary UPC preorder news
and push new matches to a phone via ntfy.sh. Stdlib only."""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

SEEN_FILE = "seen.json"
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
UA = "Mozilla/5.0 (feed-digest)"

QUERIES = [
    '"30th Celebration" "Ultra Premium Collection"',
    '"30th Celebration" UPC Pokemon Center preorder',
    '"Ultra Premium Collection" 30th anniversary Pokemon preorder',
    '"Pokemon Center" 30th anniversary "Ultra Premium Collection"',
    'Pokemon 30th anniversary UPC pre-order live',
]

# Deal/news accounts that post retailer links minutes after preorders open.
BLUESKY_ACCOUNTS = ["wario64.bsky.social", "pokeguardian.bsky.social"]

REDDIT_SUBS = ["PokemonTCG", "PKMNTCGDeals", "pokemontcgcollections"]

# An item must mention the product AND a purchase signal to trigger an alert.
PRODUCT_RE = re.compile(r"(ultra[\s-]*premium|\bUPC\b)", re.I)
ANNIV_RE = re.compile(r"(30th|thirtieth|30 ?years?|celebration)", re.I)
POKEMON_RE = re.compile(r"pok[eé]mon", re.I)
BUY_RE = re.compile(r"(pre-?order|preorders?|live|in stock|restock|drop|available now|on sale)", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def parse_feed(raw):
    """Return (id, title, link) from RSS <item> or Atom <entry> elements."""
    root = ET.fromstring(raw)
    out = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        fields = {c.tag.split("}")[-1]: c for c in el}
        title = (fields.get("title").text or "") if "title" in fields else ""
        link_el = fields.get("link")
        link = ""
        if link_el is not None:
            link = link_el.get("href") or link_el.text or ""
        guid = fields.get("guid") if "guid" in fields else fields.get("id")
        item_id = (guid.text if guid is not None and guid.text else link) or title
        out.append((item_id.strip(), title.strip(), link.strip()))
    return out


def bluesky_items(handle):
    """(id, text, link) for an account's recent posts via the public AppView API."""
    url = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?" + urllib.parse.urlencode(
        {"actor": handle, "limit": 30, "filter": "posts_no_replies"}
    )
    out = []
    for entry in json.loads(fetch(url)).get("feed", []):
        post = entry["post"]
        text = post["record"].get("text", "")
        # Prefer the retailer link the post points to; fall back to the post itself.
        link = (post.get("embed") or {}).get("external", {}).get("uri") or (
            f"https://bsky.app/profile/{handle}/post/{post['uri'].rsplit('/', 1)[-1]}"
        )
        out.append((post["uri"], text, link))
    return out


def sources():
    for q in QUERIES:
        yield "Google News", "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": q + " when:7d", "hl": "en-US", "gl": "US", "ceid": "US:en"}
        )
    for sub in REDDIT_SUBS:
        time.sleep(3)  # Reddit 429s rapid-fire unauthenticated requests
        yield f"r/{sub}", f"https://www.reddit.com/r/{sub}/search.rss?" + urllib.parse.urlencode(
            {"q": "UPC OR \"ultra premium\" 30th", "restrict_sr": 1, "sort": "new", "t": "week"}
        )


def notify(title, link, source):
    if not NTFY_TOPIC:
        print("NTFY_TOPIC not set; would notify:", title)
        return
    req = urllib.request.Request(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=f"{title}\n({source})".encode(),
        headers={
            "Title": "Pokemon 30th UPC alert",
            "Priority": "urgent",
            "Tags": "rotating_light",
            "Click": link,
        },
    )
    urllib.request.urlopen(req, timeout=20)


def main():
    try:
        with open(SEEN_FILE) as f:
            seen = set(json.load(f))
    except FileNotFoundError:
        seen = set()
    first_run = not seen

    feeds = [(src, lambda u=url: parse_feed(fetch(u)), ANNIV_RE) for src, url in sources()]
    # Deal posts are terse and may omit "30th", so accept any Pokemon UPC drop there.
    feeds += [(f"@{h}", lambda h=h: bluesky_items(h), POKEMON_RE) for h in BLUESKY_ACCOUNTS]

    hits = 0
    for source, load, topic_re in feeds:
        try:
            items = load()
        except Exception as e:  # one broken source shouldn't stop the others
            print(f"[warn] {source}: {e}", file=sys.stderr)
            continue
        for item_id, title, link in items:
            if item_id in seen:
                continue
            seen.add(item_id)
            if PRODUCT_RE.search(title) and topic_re.search(title) and BUY_RE.search(title):
                hits += 1
                print(f"[match] {source}: {title} -> {link}")
                # Don't blast old articles on the very first run; just record them.
                if not first_run:
                    notify(title, link, source)

    with open(SEEN_FILE, "w") as f:
        json.dump(sorted(seen)[-5000:], f, indent=0)
    print(f"done: {hits} new matches, {len(seen)} seen")


if __name__ == "__main__":
    main()
