package com.example.fantasybaseball.service;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Scrapes the Yahoo Sports / Justin Boone Top 300 rankings article for 2026.
 *
 * URL: see ARTICLE_URL below — update this each year before the draft.
 * The article is structured prose with numbered player entries; we parse
 * rank + player name + position from the text. Article format is fragile
 * (Yahoo can restructure), so this service degrades gracefully on failure.
 *
 * Cache: 24 hours (article updates less frequently than live data feeds).
 */
@Service
public class YahooBooneService {

    private static final Logger log = LoggerFactory.getLogger(YahooBooneService.class);
    private static final int CACHE_HOURS = 24;
    private static final int TIMEOUT_MS  = 25_000;

    /**
     * Update this URL each year — Justin Boone Top 300 for 2026.
     * Typically published mid-July to early August before the draft season.
     * See: src/Docs/football-2026/data-sources-2026.md for renewal checklist.
     */
    private static final String ARTICLE_URL =
        "https://sports.yahoo.com/fantasy/article/2026-fantasy-football-rankings-justin-boone-top-300-players-155300098.html";

    private static final List<String> USER_AGENTS = List.of(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
    );
    private static final Random RANDOM = new Random();

    // "1. Josh Allen, QB, BUF" or "1. Josh Allen (QB, BUF)" or similar
    private static final Pattern NUMBERED_LINE = Pattern.compile(
        "^(\\d{1,3})[\\.\\)]\\s+(.{3,50})"
    );
    // Position keyword inside a player entry
    private static final Pattern POS_KEYWORD = Pattern.compile(
        "\\b(QB|RB|WR|TE|K|DST|D/ST|DEF)\\b", Pattern.CASE_INSENSITIVE
    );
    // 2–4 letter uppercase team abbreviation (after the name + position)
    private static final Pattern TEAM_ABBREV = Pattern.compile("\\b([A-Z]{2,4})\\b");

    private List<YhPlayer> cache;
    private Instant        cacheTime;

    public record YhPlayer(String name, String team, String position, int rank) {}

    public List<YhPlayer> getRankings() {
        if (cache != null && cacheTime != null &&
                Duration.between(cacheTime, Instant.now()).toHours() < CACHE_HOURS) {
            return cache;
        }
        try {
            List<YhPlayer> players = fetchAndParse();
            if (!players.isEmpty()) {
                cache     = players;
                cacheTime = Instant.now();
                log.info("Yahoo Boone: {} players loaded", players.size());
            }
            return players;
        } catch (Exception e) {
            log.warn("Yahoo Boone fetch failed: {}", e.getMessage());
            return cache != null ? cache : List.of();
        }
    }

    public void invalidateCache() {
        cache     = null;
        cacheTime = null;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    private List<YhPlayer> fetchAndParse() throws Exception {
        String ua = USER_AGENTS.get(RANDOM.nextInt(USER_AGENTS.size()));
        Document doc = Jsoup.connect(ARTICLE_URL)
                .userAgent(ua)
                .timeout(TIMEOUT_MS)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "en-US,en;q=0.9")
                .ignoreHttpErrors(true)
                .followRedirects(true)
                .get();

        // Strategy 1: <ol><li> — cleanest when present
        List<YhPlayer> result = tryOrderedList(doc);
        if (result.size() > 20) return result;

        // Strategy 2: numbered paragraphs inside article body
        result = tryParagraphLines(doc);
        if (result.size() > 20) return result;

        // Strategy 3: any element whose text starts with "N. "
        return tryNumberedElements(doc);
    }

    // ── Strategy 1: <ol><li> ─────────────────────────────────────────────────

    private List<YhPlayer> tryOrderedList(Document doc) {
        for (Element ol : doc.select("ol")) {
            var items = ol.select("li");
            if (items.size() < 20) continue;
            List<YhPlayer> result = new ArrayList<>();
            int rank = 1;
            for (Element li : items) {
                YhPlayer p = parsePlayerText(rank, li.text().trim());
                if (p != null) result.add(p);
                rank++;
            }
            if (result.size() > 20) return result;
        }
        return List.of();
    }

    // ── Strategy 2: article body paragraphs ──────────────────────────────────

    private List<YhPlayer> tryParagraphLines(Document doc) {
        List<YhPlayer> result = new ArrayList<>();
        // Yahoo article containers
        for (Element body : doc.select("article, .caas-body, .article-body, [data-testid='body'], .yf-article")) {
            for (Element el : body.select("p, li")) {
                String text = el.text().trim();
                Matcher m = NUMBERED_LINE.matcher(text);
                if (!m.find()) continue;
                int rank = Integer.parseInt(m.group(1));
                if (rank < 1 || rank > 350) continue;
                YhPlayer p = parsePlayerText(rank, m.group(2).trim());
                if (p != null) result.add(p);
            }
            if (result.size() > 20) return result;
        }
        return result;
    }

    // ── Strategy 3: any numbered text element ─────────────────────────────────

    private List<YhPlayer> tryNumberedElements(Document doc) {
        Map<Integer, YhPlayer> ranked = new TreeMap<>();
        for (Element el : doc.select("p, li, td, div")) {
            String text = el.text().trim();
            Matcher m = NUMBERED_LINE.matcher(text);
            if (!m.matches()) continue;
            int rank = Integer.parseInt(m.group(1));
            if (rank < 1 || rank > 350) continue;
            YhPlayer p = parsePlayerText(rank, m.group(2).trim());
            if (p != null) ranked.putIfAbsent(rank, p);
        }
        return new ArrayList<>(ranked.values());
    }

    // ── Parse a single player text entry ─────────────────────────────────────

    /**
     * Given rank=1 and text="Josh Allen, QB, BUF" (or any variation),
     * extracts name, position, team.
     */
    private YhPlayer parsePlayerText(int rank, String rawText) {
        if (rawText == null || rawText.isBlank()) return null;

        // Strip leading "N." if present (some strategies leave it in)
        String text = rawText.replaceFirst("^\\d{1,3}[\\.\\)]\\s*", "").trim();

        // Find position keyword — everything before it is (roughly) the name
        Matcher posM = POS_KEYWORD.matcher(text);
        if (!posM.find()) return null;

        String pos = normalizePos(posM.group(1));

        // Name = text before the position keyword, cleaned of punctuation
        String rawName = text.substring(0, posM.start())
                .replaceAll("[,\\(\\)\\[\\]\\-]", " ")
                .replaceAll("\\s+", " ")
                .trim();

        // Sanity checks: real names are 3–50 chars and don't start with digits
        if (rawName.length() < 3 || rawName.length() > 50) return null;
        if (rawName.matches("^\\d.*")) return null;

        // Try to find a 2-4 char team abbreviation after the position
        String remainder = text.substring(posM.end());
        Matcher teamM = TEAM_ABBREV.matcher(remainder);
        String team = teamM.find() ? teamM.group(1) : "";

        // Exclude false positives: position strings that leaked into team slot
        if (isPosition(team)) team = "";

        return new YhPlayer(rawName, team, pos, rank);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private boolean isPosition(String s) {
        return s != null && s.matches("(?i)QB|RB|WR|TE|K|DST|D/ST|DEF|FLEX");
    }

    private String normalizePos(String pos) {
        if (pos == null || pos.isBlank()) return "WR";
        return switch (pos.toUpperCase().trim()) {
            case "DEF", "D/ST", "DST", "DEF/ST" -> "DST";
            default -> pos.toUpperCase().trim();
        };
    }
}
