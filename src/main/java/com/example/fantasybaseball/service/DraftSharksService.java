package com.example.fantasybaseball.service;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * Scrapes DraftSharks overall PPR rankings.
 * URL: https://www.draftsharks.com/rankings/ppr
 *
 * DraftSharks publishes expert consensus rankings in a static HTML table.
 * Returns empty on any failure — composite ranking handles missing source gracefully.
 * Cache: 12 hours.
 */
@Service
public class DraftSharksService {

    private static final Logger log = LoggerFactory.getLogger(DraftSharksService.class);
    private static final int CACHE_HOURS = 12;
    private static final int TIMEOUT_MS  = 20_000;

    private static final String BASE_URL_PPR      = "https://www.draftsharks.com/rankings/ppr";
    private static final String BASE_URL_STANDARD = "https://www.draftsharks.com/rankings/standard";
    private static final String BASE_URL_HALF     = "https://www.draftsharks.com/rankings/half-ppr";

    private static final List<String> USER_AGENTS = List.of(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
    );
    private static final Random RANDOM = new Random();

    private final Map<String, List<DsPlayer>> cache    = new HashMap<>();
    private final Map<String, Instant>        cacheTime = new HashMap<>();

    public record DsPlayer(String name, String team, String position, int rank) {}

    public List<DsPlayer> getRankings(String scoring) {
        String key = scoring.toLowerCase();
        Instant t = cacheTime.get(key);
        if (t != null && Duration.between(t, Instant.now()).toHours() < CACHE_HOURS) {
            return cache.getOrDefault(key, List.of());
        }

        String url = switch (key) {
            case "standard", "std", "espn_standard" -> BASE_URL_STANDARD;
            case "half", "half_ppr"                  -> BASE_URL_HALF;
            default                                   -> BASE_URL_PPR;
        };

        try {
            List<DsPlayer> players = fetchAndParse(url);
            if (!players.isEmpty()) {
                cache.put(key, players);
                cacheTime.put(key, Instant.now());
                log.info("DraftSharks: {} players loaded ({})", players.size(), scoring);
            }
            return players;
        } catch (Exception e) {
            log.warn("DraftSharks fetch failed ({}): {}", scoring, e.getMessage());
            return cache.getOrDefault(key, List.of());
        }
    }

    public void invalidateCache() {
        cache.clear();
        cacheTime.clear();
    }

    private List<DsPlayer> fetchAndParse(String url) throws Exception {
        String ua = USER_AGENTS.get(RANDOM.nextInt(USER_AGENTS.size()));
        Document doc = Jsoup.connect(url)
                .userAgent(ua)
                .timeout(TIMEOUT_MS)
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "en-US,en;q=0.9")
                .ignoreHttpErrors(true)
                .get();

        List<DsPlayer> result = new ArrayList<>();

        // DraftSharks typically renders rankings in a <table> or in <tr> elements
        // with class names containing "player" or "ranker". Try multiple selectors.
        result = tryTableParse(doc);
        if (result.isEmpty()) result = tryListParse(doc);
        if (result.isEmpty()) result = tryJsonEmbed(doc);

        return result;
    }

    /** Strategy 1: standard HTML table with rank, player, team, position columns. */
    private List<DsPlayer> tryTableParse(Document doc) {
        List<DsPlayer> result = new ArrayList<>();
        // Look for tables with ranking data
        for (Element table : doc.select("table")) {
            Elements rows = table.select("tr");
            if (rows.size() < 10) continue; // too small to be a rankings table

            for (Element row : rows) {
                Elements cells = row.select("td");
                if (cells.size() < 3) continue;

                try {
                    String rankText = cells.get(0).text().trim();
                    int rank = Integer.parseInt(rankText.replaceAll("[^0-9]", ""));
                    if (rank < 1 || rank > 400) continue;

                    // Try common column orders: rank, player, pos, team or rank, player, team, pos
                    String col1 = cells.get(1).text().trim();
                    String col2 = cells.get(2).text().trim();
                    String col3 = cells.size() > 3 ? cells.get(3).text().trim() : "";

                    String name = col1;
                    String pos  = "";
                    String team = "";

                    // Detect which col is position vs team by content
                    if (isPosition(col2)) {
                        pos  = col2; team = col3;
                    } else if (isTeam(col2)) {
                        team = col2; pos  = col3;
                    } else if (isPosition(col3)) {
                        team = col2; pos  = col3;
                    } else {
                        team = col2; pos  = col3;
                    }

                    if (!name.isEmpty() && !name.matches("(?i)player|name|rank.*")) {
                        result.add(new DsPlayer(name, team.toUpperCase(), normalizePos(pos), rank));
                    }
                } catch (NumberFormatException ignored) {}
            }
            if (result.size() > 20) return result; // found the right table
            result.clear();
        }
        return result;
    }

    /** Strategy 2: div/li list elements (some sites render rankings as ordered lists). */
    private List<DsPlayer> tryListParse(Document doc) {
        List<DsPlayer> result = new ArrayList<>();
        // Look for elements with data-rank attribute
        for (Element el : doc.select("[data-rank],[data-player-rank]")) {
            try {
                String rankStr = el.hasAttr("data-rank") ? el.attr("data-rank") : el.attr("data-player-rank");
                int rank = Integer.parseInt(rankStr.trim());

                String name = "";
                String team = "";
                String pos  = "";

                Element nameEl = el.selectFirst(".player-name,.name,[data-name]");
                if (nameEl != null) name = nameEl.text().trim();

                Element teamEl = el.selectFirst(".team,.nfl-team,[data-team]");
                if (teamEl != null) team = teamEl.text().trim();

                Element posEl = el.selectFirst(".position,.pos,[data-position]");
                if (posEl != null) pos = posEl.text().trim();

                if (!name.isEmpty() && rank > 0 && rank <= 400) {
                    result.add(new DsPlayer(name, team.toUpperCase(), normalizePos(pos), rank));
                }
            } catch (NumberFormatException ignored) {}
        }
        return result;
    }

    /** Strategy 3: look for embedded JSON rankings data in script tags. */
    private List<DsPlayer> tryJsonEmbed(Document doc) {
        // DraftSharks may embed ranking data as window.__RANKINGS__ or similar JSON.
        // This is a best-effort check — parse what we can.
        List<DsPlayer> result = new ArrayList<>();
        for (Element script : doc.select("script")) {
            String src = script.html();
            if (!src.contains("rankings") && !src.contains("players")) continue;
            // Look for patterns like {"rank":1,"name":"Josh Allen","pos":"QB","team":"BUF"}
            var rankPat   = java.util.regex.Pattern.compile("\"rank\"\\s*:\\s*(\\d+)");
            var namePat   = java.util.regex.Pattern.compile("\"(?:name|player_name)\"\\s*:\\s*\"([^\"]+)\"");
            var posPat    = java.util.regex.Pattern.compile("\"(?:pos|position)\"\\s*:\\s*\"([^\"]+)\"");
            var teamPat   = java.util.regex.Pattern.compile("\"team\"\\s*:\\s*\"([^\"]+)\"");

            // Split on player object boundaries (naive approach)
            String[] segments = src.split("\\{");
            for (String seg : segments) {
                seg = "{" + seg;
                try {
                    var rm = rankPat.matcher(seg);  if (!rm.find()) continue;
                    int rank = Integer.parseInt(rm.group(1)); if (rank < 1 || rank > 400) continue;

                    var nm = namePat.matcher(seg);  if (!nm.find()) continue;
                    String name = nm.group(1).trim();

                    var pm = posPat.matcher(seg);   String pos  = pm.find() ? pm.group(1).trim() : "";
                    var tm = teamPat.matcher(seg);  String team = tm.find() ? tm.group(1).trim() : "";

                    if (!name.isEmpty()) {
                        result.add(new DsPlayer(name, team.toUpperCase(), normalizePos(pos), rank));
                    }
                } catch (Exception ignored) {}
            }
            if (result.size() > 20) return result;
            result.clear();
        }
        return result;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private boolean isPosition(String s) {
        return s != null && s.toUpperCase().matches("QB|RB|WR|TE|K|DST|D/ST|DEF|FLEX");
    }

    private boolean isTeam(String s) {
        if (s == null) return false;
        String u = s.toUpperCase();
        return u.length() <= 4 && u.matches("[A-Z]{2,4}");
    }

    private String normalizePos(String pos) {
        if (pos == null || pos.isBlank()) return "WR";
        return switch (pos.trim().toUpperCase()) {
            case "DEF", "D/ST", "DST" -> "DST";
            default -> pos.trim().toUpperCase();
        };
    }
}
