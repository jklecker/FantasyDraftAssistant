package com.example.fantasybaseball.controller;

import com.example.fantasybaseball.model.Player;
import com.example.fantasybaseball.service.CbsRankingsService;
import com.example.fantasybaseball.service.EspnAdpService;
import com.example.fantasybaseball.service.FantasyProsService;
import com.example.fantasybaseball.service.NflDataMergeService;
import com.example.fantasybaseball.service.NflPlayerService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/nfl")
public class NflController {

    @Autowired private NflDataMergeService mergeService;
    @Autowired private NflPlayerService    sleeperService;
    @Autowired private FantasyProsService  fpService;
    @Autowired private EspnAdpService      espnService;
    @Autowired private CbsRankingsService  cbsService;

    /**
     * GET /nfl/players?scoring=ppr|standard|half_ppr
     * Returns merged player pool with rankings, ADP, and season projections.
     */
    @GetMapping("/players")
    public List<Player> getPlayers(
            @RequestParam(defaultValue = "ppr") String scoring) {
        return mergeService.getMergedPlayers(scoring);
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
        return ResponseEntity.ok(Map.of("status", "Cache cleared. Next request will re-fetch."));
    }

    /**
     * GET /nfl/status — shows cache freshness without triggering a fetch.
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok(Map.of(
                "sleeperPlayerCount", sleeperService.getPlayers().size(),
                "fpRankingsPpr",      fpService.getRankings("ppr").size(),
                "fpProjectionsPpr",   fpService.getProjections("ppr").size(),
                "espnRankingsPpr",    espnService.getRankings("ppr").size(),
                "cbsRankingsPpr",     cbsService.getRankings("ppr").size()
        ));
    }
}
