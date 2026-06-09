package com.example.fantasybaseball.service;

import org.jsoup.HttpStatusException;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class FantasyProsService {

    private static final Logger log = LoggerFactory.getLogger(FantasyProsService.class);
    private static final int TIMEOUT_MS = 20_000;

    private static final List<String> USER_AGENTS = List.of(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
    );
    private static final Random RANDOM = new Random();

    private final Map<String, List<FpRanking>>   rankCache = new HashMap<>();
    private final Map<String, Instant>           rankTime  = new HashMap<>();
    private final Map<String, List<FpProjection>> projCache = new HashMap<>();
    private final Map<String, Instant>           projTime  = new HashMap<>();

    // ── Rankings ──────────────────────────────────────────────────────────────

    public List<FpRanking> getRankings(String scoring) {
        if (isFresh(rankTime.get(scoring), 6)) return rankCache.get(scoring);
        String url = "https://www.fantasypros.com/nfl/rankings/" + scoringSlug(scoring) + "-cheatsheet.php";
        try {
            log.info("Fetching FP rankings: {}", url);
            String html = fetchHtmlWithRetry(url, 3);
            List<FpRanking> list = parseRankingsJson(html);
            if (!list.isEmpty()) {
                rankCache.put(scoring, list);
                rankTime.put(scoring, Instant.now());
                log.info("Loaded {} FP rankings ({})", list.size(), scoring);
                return list;
            }
            log.warn("FP rankings parse returned empty for {}", scoring);
        } catch (Exception e) {
            log.warn("FP rankings fetch failed ({}): {}", scoring, e.getMessage());
        }
        return rankCache.getOrDefault(scoring, List.of());
    }

    // ── Projections ───────────────────────────────────────────────────────────

    public List<FpProjection> getProjections(String scoring) {
        if (isFresh(projTime.get(scoring), 12)) return projCache.get(scoring);
        String fpScoring = fpScoringParam(scoring);
        List<FpProjection> all = new ArrayList<>();
        // K and DST have no meaningful season projection table — skip them
        for (String pos : List.of("qb", "rb", "wr", "te")) {
            String url = "https://www.fantasypros.com/nfl/projections/" + pos
                    + ".php?week=draft&scoring=" + fpScoring;
            try {
                log.info("Fetching FP projections: {}", url);
                Document doc = fetchDocWithRetry(url, 3);
                List<FpProjection> parsed = parseProjectionTable(doc, pos.toUpperCase());
                log.info("  {} {} projections from {}", parsed.size(), pos.toUpperCase(), scoring);
                all.addAll(parsed);
            } catch (Exception e) {
                log.warn("FP projection fetch failed ({} {}): {}", pos, scoring, e.getMessage());
            }
        }
        if (!all.isEmpty()) {
            projCache.put(scoring, all);
            projTime.put(scoring, Instant.now());
        }
        return projCache.getOrDefault(scoring, List.of());
    }

    public void invalidateCache() {
        rankCache.clear(); rankTime.clear();
        projCache.clear(); projTime.clear();
    }

    // ── HTTP fetch with retry + UA rotation ───────────────────────────────────

    private String fetchHtmlWithRetry(String url, int maxAttempts) throws Exception {
        Exception last = null;
        for (int i = 0; i < maxAttempts; i++) {
            try {
                if (i > 0) Thread.sleep(1500L * i);
                String ua = USER_AGENTS.get(RANDOM.nextInt(USER_AGENTS.size()));
                return Jsoup.connect(url)
                        .userAgent(ua)
                        .timeout(TIMEOUT_MS)
                        .ignoreHttpErrors(false)
                        .get()
                        .html();
            } catch (HttpStatusException e) {
                last = e;
                // 4xx (except 429 rate-limit) won't improve with retries — bail immediately
                if (e.getStatusCode() >= 400 && e.getStatusCode() != 429 && e.getStatusCode() < 500) {
                    throw e;
                }
                log.debug("FP fetch attempt {} failed ({}): {}", i + 1, e.getStatusCode(), e.getMessage());
            } catch (Exception e) {
                last = e;
                log.debug("FP fetch attempt {} failed: {}", i + 1, e.getMessage());
            }
        }
        throw last != null ? last : new RuntimeException("All fetch attempts failed: " + url);
    }

    private Document fetchDocWithRetry(String url, int maxAttempts) throws Exception {
        Exception last = null;
        for (int i = 0; i < maxAttempts; i++) {
            try {
                if (i > 0) Thread.sleep(1500L * i);
                String ua = USER_AGENTS.get(RANDOM.nextInt(USER_AGENTS.size()));
                return Jsoup.connect(url)
                        .userAgent(ua)
                        .timeout(TIMEOUT_MS)
                        .ignoreHttpErrors(false)
                        .get();
            } catch (HttpStatusException e) {
                last = e;
                if (e.getStatusCode() >= 400 && e.getStatusCode() != 429 && e.getStatusCode() < 500) {
                    throw e;
                }
                log.debug("FP doc fetch attempt {} failed ({}): {}", i + 1, e.getStatusCode(), e.getMessage());
            } catch (Exception e) {
                last = e;
                log.debug("FP doc fetch attempt {} failed: {}", i + 1, e.getMessage());
            }
        }
        throw last != null ? last : new RuntimeException("All fetch attempts failed: " + url);
    }

    // ── Parsers ───────────────────────────────────────────────────────────────

    private static final Pattern ECR_PATTERN =
            Pattern.compile("var\\s+ecrData\\s*=\\s*(\\{.*?\\});", Pattern.DOTALL);

    @SuppressWarnings("unchecked")
    private List<FpRanking> parseRankingsJson(String html) {
        List<FpRanking> result = new ArrayList<>();
        try {
            Matcher m = ECR_PATTERN.matcher(html);
            if (!m.find()) {
                log.warn("ecrData not found in FP rankings page — page may have changed or been blocked");
                return result;
            }
            String json = m.group(1);
            com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
            Map<String, Object> root = om.readValue(json, new com.fasterxml.jackson.core.type.TypeReference<>() {});
            List<Map<String, Object>> players = (List<Map<String, Object>>) root.get("players");
            if (players == null) return result;
            int autoRank = 1;
            for (Map<String, Object> p : players) {
                FpRanking r  = new FpRanking();
                r.name       = str(p, "player_name");
                r.team       = str(p, "player_team_id");
                r.position   = str(p, "player_position_id");
                r.rank       = num(p, "rank_ecr") > 0 ? (int) num(p, "rank_ecr") : autoRank;
                r.posRank    = str(p, "pos_rank");
                r.adp        = num(p, "r2p_pts") > 0 ? num(p, "r2p_pts") : r.rank;
                if (r.name != null && !r.name.isBlank()) { result.add(r); autoRank++; }
            }
        } catch (Exception e) {
            log.warn("Rankings JSON parse failed: {}", e.getMessage());
        }
        return result;
    }

    private List<FpProjection> parseProjectionTable(Document doc, String position) {
        List<FpProjection> result = new ArrayList<>();
        try {
            Element table = doc.selectFirst("table#data");
            if (table == null) table = doc.selectFirst("table.table");
            if (table == null) {
                log.warn("No projection table found for {}", position);
                return result;
            }

            Elements headers = table.select("thead th");
            List<String> cols = new ArrayList<>();
            for (Element h : headers) cols.add(h.text().trim().toLowerCase());

            for (Element row : table.select("tbody tr")) {
                Elements cells = row.select("td");
                if (cells.isEmpty()) continue;
                FpProjection p = new FpProjection();
                p.position    = position;
                p.stats       = new HashMap<>();

                // Player name cell — may contain link and/or " - TEAM" suffix
                Element nameCell = cells.get(0);
                Element link     = nameCell.selectFirst("a.player-name, a[href*='/nfl/players/']");
                String  raw      = link != null ? link.text().trim() : nameCell.text().trim();
                if (raw.contains(" - ")) {
                    String[] parts = raw.split(" - ", 2);
                    p.name = parts[0].trim();
                    p.team = parts[1].trim();
                } else {
                    p.name = raw;
                }

                for (int i = 1; i < cells.size() && i < cols.size(); i++) {
                    double val = parseDouble(cells.get(i).text());
                    mapColumn(cols.get(i), val, p, position);
                }
                if (p.name != null && !p.name.isBlank()) result.add(p);
            }
        } catch (Exception e) {
            log.warn("Projection table parse failed ({}): {}", position, e.getMessage());
        }
        return result;
    }

    private void mapColumn(String col, double val, FpProjection p, String pos) {
        switch (col) {
            case "fpts", "pts", "fantasy pts", "fptsi", "fan pts" -> p.fantasyPoints = val;
            case "att" -> { if ("QB".equals(pos)) p.stats.put("passAtt", val);
                            else                  p.stats.put("rushAtt", val); }
            case "cmp"   -> p.stats.put("passCmp",   val);
            case "ints"  -> p.stats.put("passInt",   val);
            case "rec"   -> p.stats.put("receptions", val);
            case "tgt"   -> p.stats.put("targets",   val);
            case "fl", "fum" -> p.stats.put("fumbleLost", val);
            case "yds"   -> {
                // FantasyPros tables repeat "yds" for pass/rush/rec — map in order
                if ("QB".equals(pos) && !p.stats.containsKey("passYards"))       p.stats.put("passYards", val);
                else if (!p.stats.containsKey("rushYards") && !"WR".equals(pos)) p.stats.put("rushYards", val);
                else                                                               p.stats.put("recYards",  val);
            }
            case "tds"   -> {
                if ("QB".equals(pos) && !p.stats.containsKey("passTD"))       p.stats.put("passTD",  val);
                else if (!p.stats.containsKey("rushTD") && !"WR".equals(pos)) p.stats.put("rushTD",  val);
                else                                                            p.stats.put("recTD",   val);
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String scoringSlug(String s) {
        return switch (s.toLowerCase()) {
            case "standard", "std" -> "consensus";
            case "half", "half_ppr" -> "half-point-ppr";
            default -> "ppr";
        };
    }

    private String fpScoringParam(String s) {
        return switch (s.toLowerCase()) {
            case "standard", "std" -> "STD";
            case "half", "half_ppr" -> "HALF";
            default -> "PPR";
        };
    }

    private boolean isFresh(Instant t, long maxHours) {
        return t != null && Duration.between(t, Instant.now()).toHours() < maxHours;
    }

    private String str(Map<String, Object> m, String k) {
        Object v = m.get(k);
        return v instanceof String s ? s.trim() : (v != null ? v.toString().trim() : null);
    }

    private double num(Map<String, Object> m, String k) {
        Object v = m.get(k);
        if (v instanceof Number n) return n.doubleValue();
        if (v instanceof String s) try { return Double.parseDouble(s); } catch (Exception ignored) {}
        return 0;
    }

    private double parseDouble(String s) {
        if (s == null) return 0;
        try { return Double.parseDouble(s.replaceAll("[^0-9.\\-]", "")); }
        catch (Exception e) { return 0; }
    }

    public static class FpRanking {
        public String name, team, position, posRank;
        public int    rank;
        public double adp;
    }

    public static class FpProjection {
        public String              name, team, position;
        public double              fantasyPoints;
        public Map<String, Double> stats = new HashMap<>();
    }
}
