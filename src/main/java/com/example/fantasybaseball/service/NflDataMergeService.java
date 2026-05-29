package com.example.fantasybaseball.service;

import com.example.fantasybaseball.model.Player;
import com.example.fantasybaseball.util.FuzzyMatcher;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Joins Sleeper player pool with FantasyPros rankings + projections.
 * Fuzzy-matches on normalized name to handle apostrophes, suffixes, D/ST variants, etc.
 */
@Service
public class NflDataMergeService {

    private static final Logger log = LoggerFactory.getLogger(NflDataMergeService.class);
    private static final int NFL_ID_OFFSET = 10_000;
    private static final int MAX_FP_ONLY_RANK = 250; // don't add FP-only players ranked beyond this

    @Autowired private NflPlayerService   sleeperSvc;
    @Autowired private FantasyProsService fpSvc;
    @Autowired private EspnAdpService     espnSvc;
    @Autowired private CbsRankingsService cbsSvc;

    public List<Player> getMergedPlayers(String scoring) {
        List<NflPlayerService.SleeperPlayer>  sleeperPlayers = sleeperSvc.getPlayers();
        List<FantasyProsService.FpRanking>    rankings       = fpSvc.getRankings(scoring);
        List<FantasyProsService.FpProjection> projections    = fpSvc.getProjections(scoring);
        List<EspnAdpService.EspnPlayer>       espnRankings   = espnSvc.getRankings(scoring);
        List<CbsRankingsService.CbsPlayer>    cbsRankings    = cbsSvc.getRankings(scoring);

        // Index FP data by normalized name
        Map<String, FantasyProsService.FpRanking>    rankMap = indexByName(rankings,   r -> r.name);
        Map<String, FantasyProsService.FpProjection> projMap = indexByName(projections, p -> p.name);
        Map<String, EspnAdpService.EspnPlayer>       espnMap = indexByName(espnRankings, e -> e.name);
        Map<String, CbsRankingsService.CbsPlayer>    cbsMap  = indexByName(cbsRankings,  c -> c.name);

        // Secondary DST index: "san francisco 49ers" → DST entry keyed by "san francisco 49ers dst"
        Map<String, FantasyProsService.FpRanking> dstRankMap = new LinkedHashMap<>();
        for (FantasyProsService.FpRanking r : rankings) {
            if (r.name != null && r.name.toLowerCase().contains("d/st")) {
                String key = normalize(r.name.replace("D/ST", "").trim());
                dstRankMap.put(key, r);
            }
        }

        AtomicInteger idCounter = new AtomicInteger(NFL_ID_OFFSET + 1);
        List<Player>  result    = new ArrayList<>();
        Set<String>   addedKeys = new HashSet<>();

        // 1. Sleeper base players
        for (NflPlayerService.SleeperPlayer sp : sleeperPlayers) {
            String key = normalize(sp.fullName);
            if (addedKeys.contains(key)) continue;

            Player p = buildPlayer(idCounter.getAndIncrement(), sp.fullName,
                    sp.team, normalizePosition(sp.position));
            p.setSport("football");

            // Attach FP ranking
            FantasyProsService.FpRanking rank = findBest(sp.fullName, rankMap);
            if (rank == null && "DST".equals(p.getPosition())) {
                rank = dstRankMap.get(normalize(sp.fullName));
            }
            if (rank != null) p.setAdp((double) rank.rank);

            // Attach FP projection
            FantasyProsService.FpProjection proj = findBest(sp.fullName, projMap);
            if (proj != null) attachProjection(p, proj);

            // Composite rank: average across available sources (FP, ESPN, CBS).
            EspnAdpService.EspnPlayer    eRank = findBest(sp.fullName, espnMap);
            CbsRankingsService.CbsPlayer cRank = findBest(sp.fullName, cbsMap);
            attachComposite(p, rank, eRank, cRank);

            result.add(p);
            addedKeys.add(key);
        }

        // 2. FP-only players not in Sleeper (ranked ≤ MAX_FP_ONLY_RANK)
        for (FantasyProsService.FpRanking rank : rankings) {
            if (rank.name == null || rank.rank > MAX_FP_ONLY_RANK) continue;
            String key = normalize(rank.name);
            if (addedKeys.contains(key)) continue;

            Player p = buildPlayer(idCounter.getAndIncrement(), rank.name,
                    rank.team, normalizePosition(rank.position));
            p.setSport("football");
            p.setAdp((double) rank.rank);

            FantasyProsService.FpProjection proj = findBest(rank.name, projMap);
            if (proj != null) attachProjection(p, proj);

            EspnAdpService.EspnPlayer    eRank = findBest(rank.name, espnMap);
            CbsRankingsService.CbsPlayer cRank = findBest(rank.name, cbsMap);
            attachComposite(p, rank, eRank, cRank);

            result.add(p);
            addedKeys.add(key);
        }

        // Sort by composite rank when available, else ADP (nulls last in both cases).
        result.sort(Comparator.comparingDouble(p -> {
            Map<String, Double> ng = p.getNextGen();
            if (ng != null && ng.get("compositeRank") != null) return ng.get("compositeRank");
            return p.getAdp() != null ? p.getAdp() : 9999;
        }));

        // Assign overall + per-position ranks after sort
        Map<String, Integer> posCounters = new HashMap<>();
        for (int i = 0; i < result.size(); i++) {
            Player p = result.get(i);
            int posRank = posCounters.merge(p.getPosition(), 1, Integer::sum);
            Map<String, Double> ng = p.getNextGen() != null ? new HashMap<>(p.getNextGen()) : new HashMap<>();
            ng.put("overallRank", (double)(i + 1));
            ng.put("posRank", (double) posRank);
            p.setNextGen(ng);
        }

        log.info("Merged {} NFL players ({})", result.size(), scoring);
        return result;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Player buildPlayer(int id, String name, String team, String position) {
        Player p = new Player();
        p.setId(id);
        p.setName(name != null ? name : "Unknown");
        p.setTeam(team != null ? team : "FA");
        p.setPosition(position != null ? position : "WR");
        return p;
    }

    private void attachProjection(Player p, FantasyProsService.FpProjection proj) {
        p.setStats(proj.stats);
        Map<String, Double> ng = p.getNextGen() != null ? new HashMap<>(p.getNextGen()) : new HashMap<>();
        ng.put("projectedPoints", proj.fantasyPoints);
        p.setNextGen(ng);
    }

    /**
     * Composite rank = mean of per-source ranks (FantasyPros ECR, ESPN ADP, CBS).
     * Stored on the Player's nextGen map alongside the per-source ranks and a count
     * of contributing sources so the UI can show a "consensus confidence" indicator.
     */
    private void attachComposite(Player p,
                                 FantasyProsService.FpRanking fp,
                                 EspnAdpService.EspnPlayer espn,
                                 CbsRankingsService.CbsPlayer cbs) {
        List<Double> ranks = new ArrayList<>();
        Map<String, Double> ng = p.getNextGen() != null ? new HashMap<>(p.getNextGen()) : new HashMap<>();

        if (fp != null)   { ranks.add((double) fp.rank);   ng.put("fpRank",   (double) fp.rank); }
        if (espn != null) { ranks.add(espn.adp);           ng.put("espnAdp",  espn.adp); }
        if (cbs != null)  { ranks.add((double) cbs.rank);  ng.put("cbsRank",  (double) cbs.rank); }

        if (!ranks.isEmpty()) {
            double mean = ranks.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            ng.put("compositeRank",  mean);
            ng.put("sourceCount",    (double) ranks.size());
        }
        p.setNextGen(ng);
    }

    private String normalizePosition(String pos) {
        if (pos == null) return "WR";
        return switch (pos.toUpperCase()) {
            case "DEF", "D/ST", "DST" -> "DST";
            default -> pos.toUpperCase();
        };
    }

    private <T> Map<String, T> indexByName(List<T> list, Function<T, String> nameGetter) {
        Map<String, T> map = new LinkedHashMap<>();
        for (T item : list) {
            String name = nameGetter.apply(item);
            if (name != null) map.putIfAbsent(normalize(name), item);
        }
        return map;
    }

    private <T> T findBest(String name, Map<String, T> index) {
        if (name == null) return null;
        String key = normalize(name);
        if (index.containsKey(key)) return index.get(key);
        T best = null;
        double bestScore = 0.70;
        for (Map.Entry<String, T> e : index.entrySet()) {
            double s = FuzzyMatcher.score(key, e.getKey());
            if (s > bestScore) { bestScore = s; best = e.getValue(); }
        }
        return best;
    }

    /**
     * Normalize a player name for cross-source matching.
     * Package-private + static so NflNameNormalizationTest can call it directly.
     */
    public static String normalize(String s) {
        if (s == null) return "";
        return s.toLowerCase()
                // Unicode + straight apostrophes
                .replaceAll("[\u2018\u2019\u201B'`]", "")
                // D/ST → dst
                .replaceAll("d/st", "dst")
                // Name suffixes
                .replaceAll("\\b(jr|sr|ii|iii|iv)\\b\\.?", "")
                // Strip trailing team abbreviation if present (e.g. "Josh Allen QB BUF")
                .replaceAll("\\s+(qb|rb|wr|te|k|dst|def)\\s*$", "")
                // Non alphanumeric except space
                .replaceAll("[^a-z0-9 ]", "")
                .replaceAll("\\s+", " ")
                .trim();
    }
}
