package com.example.fantasybaseball.controller;

import com.example.fantasybaseball.model.Player;
import com.example.fantasybaseball.service.CbsRankingsService;
import com.example.fantasybaseball.service.DraftSharksService;
import com.example.fantasybaseball.service.EspnAdpService;
import com.example.fantasybaseball.service.FantasyLifeService;
import com.example.fantasybaseball.service.FantasyProsService;
import com.example.fantasybaseball.service.MarkdownRankingsService;
import com.example.fantasybaseball.service.NflDataMergeService;
import com.example.fantasybaseball.service.NflPlayerService;
import com.example.fantasybaseball.service.YahooBooneService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/nfl")
public class NflController {

    private static final Logger log = LoggerFactory.getLogger(NflController.class);

    @Autowired private NflDataMergeService    mergeService;
    @Autowired private NflPlayerService       sleeperService;
    @Autowired private FantasyProsService     fpService;
    @Autowired private EspnAdpService         espnService;
    @Autowired private CbsRankingsService     cbsService;
    @Autowired private MarkdownRankingsService mdService;
    @Autowired private DraftSharksService     dsService;
    @Autowired private FantasyLifeService     flService;
    @Autowired private YahooBooneService      yhService;

    /**
     * GET /nfl/players?scoring=ppr|standard|half_ppr
     * Returns merged player pool with rankings, ADP, and season projections.
     */
    @GetMapping("/players")
    public ResponseEntity<List<Player>> getPlayers(
            @RequestParam(defaultValue = "ppr") String scoring) {
        try {
            return ResponseEntity.ok(mergeService.getMergedPlayers(scoring));
        } catch (Exception e) {
            log.error("getMergedPlayers failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * POST /nfl/refresh — bust all caches and re-fetch from sources.
     */
    @PostMapping("/refresh")
    public ResponseEntity<Map<String, String>> refresh() {
        sleeperService.invalidateCache();
        fpService.invalidateCache();
        espnService.invalidateCache();
        cbsService.invalidateCache();
        dsService.invalidateCache();
        flService.invalidateCache();
        yhService.invalidateCache();
        return ResponseEntity.ok(Map.of("status", "Cache cleared. Next request will re-fetch."));
    }

    /**
     * GET /nfl/status — shows cache freshness without triggering a fetch.
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok(Map.ofEntries(
                Map.entry("sleeperPlayerCount",   sleeperService.getPlayers().size()),
                Map.entry("fpRankingsPpr",        fpService.getRankings("ppr").size()),
                Map.entry("fpProjectionsPpr",     fpService.getProjections("ppr").size()),
                Map.entry("espnRankingsPpr",      espnService.getRankings("ppr").size()),
                Map.entry("cbsRankingsPpr",       cbsService.getRankings("ppr").size()),
                Map.entry("berryRankings",        mdService.getRankings().size()),
                Map.entry("berryAgeData",         mdService.getAgeData().size()),
                Map.entry("draftSharksRankings",  dsService.getRankings("ppr").size()),
                Map.entry("fantasyLifeRankings",  flService.getRankings("ppr").size()),
                Map.entry("yahooBooneRankings",   yhService.getRankings().size())
        ));
    }
}
