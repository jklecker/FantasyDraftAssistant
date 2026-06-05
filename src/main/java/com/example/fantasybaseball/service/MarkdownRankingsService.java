package com.example.fantasybaseball.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses the local rankings-2026.md file (src/main/resources/rankings-2026.md).
 *
 * Extracts:
 *   - Matthew Berry positional rankings (QB/RB/WR/TE) → converted to approximate overall rank
 *   - Player ages from the Trade Values table → used to annotate players
 *   - ADP midpoints from the Trade Values table → additional ADP signal
 *
 * This is a guaranteed-available source (bundled in the jar) so it never fails.
 * Estimated overall ranks are intentionally rough — the composite just averages them
 * with up to 4 other sources, so directional accuracy is sufficient.
 */
@Service
public class MarkdownRankingsService {

    private static final Logger log = LoggerFactory.getLogger(MarkdownRankingsService.class);

    // Matches a markdown table row: | 1 | Josh Allen | BUF | ...notes... |
    private static final Pattern RANK_ROW = Pattern.compile(
            "^\\|\\s*(\\d{1,2})\\s*\\|\\s*(.+?)\\s*\\|\\s*([A-Z]{2,4})\\s*\\|");

    // Matches the Trade Values table: | Bijan Robinson | RB | ATL | 24 | 1-3 | ... |
    private static final Pattern TRADE_ROW = Pattern.compile(
            "^\\|\\s*(.+?)\\s*\\|\\s*(QB|RB|WR|TE|K)\\s*\\|\\s*([A-Z]{2,4})\\s*\\|\\s*(\\d+)\\s*\\|\\s*([\\d\\-]+)\\s*\\|");

    // Section headers that signal position context
    private static final Pattern POS_HEADER = Pattern.compile(
            "###\\s+(QB|RB|WR|TE|K)\\s+Rankings", Pattern.CASE_INSENSITIVE);

    public record MdPlayer(String name, String team, String position, int posRank, int estimatedOverallRank) {}
    public record AgeEntry(String name, String team, String position, int age, double adpMidpoint) {}

    private List<MdPlayer>  cachedRankings  = null;
    private List<AgeEntry>  cachedAgeData   = null;

    public List<MdPlayer> getRankings() {
        if (cachedRankings != null) return cachedRankings;
        cachedRankings = loadRankings();
        return cachedRankings;
    }

    public List<AgeEntry> getAgeData() {
        if (cachedAgeData != null) return cachedAgeData;
        cachedAgeData = loadAgeData();
        return cachedAgeData;
    }

    // ── Rankings (Berry positional → estimated overall) ───────────────────────

    private List<MdPlayer> loadRankings() {
        List<MdPlayer> result = new ArrayList<>();
        try {
            var res = new ClassPathResource("rankings-2026.md");
            if (!res.exists()) {
                log.warn("rankings-2026.md not found on classpath");
                return result;
            }
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(res.getInputStream(), StandardCharsets.UTF_8))) {

                String currentPos = null;
                String line;
                while ((line = br.readLine()) != null) {
                    // Detect section header
                    Matcher hm = POS_HEADER.matcher(line);
                    if (hm.find()) {
                        currentPos = hm.group(1).toUpperCase();
                        continue;
                    }
                    // Stop collecting when we hit the ESPN Field Yates section or Trade Values
                    if (line.startsWith("## ESPN Field Yates") || line.startsWith("## Key 2026")) {
                        currentPos = null;
                    }
                    if (currentPos == null) continue;

                    Matcher rm = RANK_ROW.matcher(line);
                    if (rm.find()) {
                        try {
                            int posRank = Integer.parseInt(rm.group(1));
                            String name = rm.group(2).trim();
                            String team = rm.group(3).trim();
                            // Skip header rows
                            if (name.equalsIgnoreCase("Player") || name.equalsIgnoreCase("Rank")) continue;

                            int overall = estimateOverall(currentPos, posRank);
                            result.add(new MdPlayer(name, team, currentPos, posRank, overall));
                        } catch (NumberFormatException ignored) {}
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Failed to parse rankings-2026.md rankings: {}", e.getMessage());
        }
        log.info("Markdown rankings: {} Berry players loaded", result.size());
        return result;
    }

    // ── Age / ADP data (Trade Values table) ───────────────────────────────────

    private List<AgeEntry> loadAgeData() {
        List<AgeEntry> result = new ArrayList<>();
        try {
            var res = new ClassPathResource("rankings-2026.md");
            if (!res.exists()) return result;
            boolean inTradeTable = false;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(res.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    if (line.contains("Trade Values + Age Reference")) { inTradeTable = true; continue; }
                    if (inTradeTable && line.startsWith("### ")) break; // next section
                    if (!inTradeTable) continue;

                    Matcher m = TRADE_ROW.matcher(line);
                    if (m.find()) {
                        String name = m.group(1).trim();
                        String pos  = m.group(2).trim();
                        String team = m.group(3).trim();
                        int age     = Integer.parseInt(m.group(4));
                        double adp  = parseAdpRange(m.group(5));
                        if (name.equalsIgnoreCase("Player")) continue;
                        result.add(new AgeEntry(name, team, pos, age, adp));
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Failed to parse rankings-2026.md age data: {}", e.getMessage());
        }
        log.info("Markdown age data: {} players loaded", result.size());
        return result;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Rough positional rank → estimated overall rank for a 12-team PPR draft.
     * Not precise — used as one of 5 composite inputs, so directional is enough.
     */
    private int estimateOverall(String pos, int posRank) {
        return switch (pos) {
            case "RB" -> posRank * 5;              // RB1≈5, RB10≈50
            case "WR" -> posRank * 5 + 6;          // WR1≈11, WR10≈56
            case "QB" -> posRank * 18;             // QB1≈18, QB5≈90
            case "TE" -> posRank * 12 + 40;        // TE1≈52, TE5≈100
            default   -> posRank * 8;
        };
    }

    /** Parse "1-3" or "15-25" to midpoint. Returns the midpoint as double. */
    private double parseAdpRange(String s) {
        if (s == null || s.isBlank()) return 0;
        String[] parts = s.trim().split("-");
        if (parts.length == 2) {
            try {
                double lo = Double.parseDouble(parts[0].trim());
                double hi = Double.parseDouble(parts[1].trim());
                return (lo + hi) / 2.0;
            } catch (NumberFormatException ignored) {}
        }
        try { return Double.parseDouble(s.trim()); } catch (NumberFormatException ignored) {}
        return 0;
    }
}
