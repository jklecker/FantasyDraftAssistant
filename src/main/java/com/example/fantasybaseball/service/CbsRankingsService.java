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

/**
 * Best-effort scraper for CBS Sports fantasy football rankings.
 * CBS publishes consensus rankings as static HTML at:
 *   https://www.cbssports.com/fantasy/football/rankings/{ppr|standard|half-ppr}/all/
 *
 * Scraping is fragile by nature — page structure can change without notice.
 * Returns empty list on any failure; composite ranking will skip CBS for that fetch.
 */
@Service
public class CbsRankingsService {

    private static final Logger log = LoggerFactory.getLogger(CbsRankingsService.class);
    private static final int CACHE_HOURS = 24;
    private static final int TIMEOUT_MS = 15_000;

    private static final String UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "Chrome/124.0.0.0 Safari/537.36";

    private final Map<String, List<CbsPlayer>> cache = new HashMap<>();
    private final Map<String, Instant>         cacheTime = new HashMap<>();

    public List<CbsPlayer> getRankings(String scoring) {
        String key = scoring.toLowerCase();
        Instant t = cacheTime.get(key);
        if (t != null && Duration.between(t, Instant.now()).toHours() < CACHE_HOURS) {
            return cache.get(key);
        }

        String slug = switch (key) {
            case "standard", "std"  -> "non-ppr";
            case "half", "half_ppr" -> "half-ppr";
            default                 -> "ppr";
        };
        String url = "https://www.cbssports.com/fantasy/football/rankings/" + slug + "/all/";

        try {
            log.info("Fetching CBS rankings: {}", url);
            Document doc = Jsoup.connect(url)
                    .userAgent(UA)
                    .timeout(TIMEOUT_MS)
                    .ignoreHttpErrors(false)
                    .get();

            List<CbsPlayer> parsed = parse(doc);
            if (!parsed.isEmpty()) {
                cache.put(key, parsed);
                cacheTime.put(key, Instant.now());
                log.info("Loaded {} CBS rankings ({})", parsed.size(), scoring);
            } else {
                log.warn("CBS rankings page parsed but yielded no players — table layout may have changed");
            }
            return parsed;
        } catch (Exception e) {
            log.warn("CBS rankings fetch failed: {}", e.getMessage());
            return cache.getOrDefault(key, List.of());
        }
    }

    public void invalidateCache() {
        cache.clear();
        cacheTime.clear();
    }

    private List<CbsPlayer> parse(Document doc) {
        List<CbsPlayer> result = new ArrayList<>();
        // CBS uses a TableBase table with rows containing player anchor tags.
        // We accept any table with rows whose first link points to /players/.
        for (Element row : doc.select("table tbody tr")) {
            Element nameLink = row.selectFirst("a[href*='/fantasy/football/players/']");
            if (nameLink == null) continue;
            String name = nameLink.text().trim();
            if (name.isBlank()) continue;

            CbsPlayer p = new CbsPlayer();
            p.name = name;
            p.rank = result.size() + 1; // rows are pre-sorted by rank
            result.add(p);
        }
        return result;
    }

    public static class CbsPlayer {
        public String name;
        public int    rank;
    }
}
