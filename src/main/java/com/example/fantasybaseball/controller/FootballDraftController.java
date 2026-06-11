package com.example.fantasybaseball.controller;

import com.example.fantasybaseball.model.FootballPick;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Shared football draft board — stores the running list of picks in memory so all
 * 12 league members see the same draft as it happens. Each client polls GET /api/football/picks
 * every few seconds and adds their own picks via POST.
 *
 * State is in-memory (resets on server restart — same as the baseball draft). This is
 * intentional: Render free tier restarts between drafts anyway.
 *
 * Each user still stores their own "my team" slot in localStorage (footballTeamPos) so
 * the "Your Team" panel and Best Pick recommendations remain personal.
 */
@RestController
@RequestMapping("/api/football")
public class FootballDraftController {

    // CopyOnWriteArrayList for safe concurrent reads during polling
    private final CopyOnWriteArrayList<FootballPick> picks = new CopyOnWriteArrayList<>();

    /** Return the full pick list — polled every few seconds by all clients. */
    @GetMapping("/picks")
    public List<FootballPick> getPicks() {
        return picks;
    }

    /**
     * Add a single pick. The client sends { playerId, teamSlot, overall } computed
     * from its snake-order logic. Returns 409 if that player is already drafted.
     */
    @PostMapping("/picks")
    public ResponseEntity<FootballPick> addPick(@RequestBody FootballPick pick) {
        boolean duplicate = picks.stream().anyMatch(p -> p.getPlayerId() == pick.getPlayerId());
        if (duplicate) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        }
        picks.add(pick);
        return ResponseEntity.status(HttpStatus.CREATED).body(pick);
    }

    /**
     * Replace the full pick list — used when a pick is undone (remove + re-number)
     * or when team size changes and all slots need recalculating.
     */
    @PutMapping("/picks")
    public List<FootballPick> replacePicks(@RequestBody List<FootballPick> newPicks) {
        picks.clear();
        picks.addAll(newPicks);
        return picks;
    }

    /** Clear all picks — called on "Start New Draft". */
    @DeleteMapping("/picks")
    public ResponseEntity<Void> clearPicks() {
        picks.clear();
        return ResponseEntity.noContent().build();
    }
}
