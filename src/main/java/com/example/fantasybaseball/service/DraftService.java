package com.example.fantasybaseball.service;

import com.example.fantasybaseball.dto.KeeperDTO;
import com.example.fantasybaseball.model.*;
import com.example.fantasybaseball.util.FuzzyMatcher;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Core draft engine. Manages state, snake-order advancement,
 * keeper assignment, and pick submission.
 *
 * <p>All public methods are synchronized on this instance. DraftService is a
 * Spring singleton holding mutable in-memory state, so synchronization prevents
 * race conditions when multiple requests arrive concurrently (e.g. two browser
 * tabs submitting a pick at the same time).
 */
@Service
public class DraftService {

    private DraftState draftState;

    public synchronized void initializeDraft(List<Team> teams, List<Player> players, boolean snakeOrder) {
        draftState = new DraftState();
        draftState.setTeams(new ArrayList<>(teams));
        draftState.setAvailablePlayers(new ArrayList<>(players));
        draftState.setDraftedPlayers(new ArrayList<>());
        draftState.setRound(1);
        draftState.setCurrentPick(1);
        draftState.setSnakeOrder(snakeOrder);
    }

    public synchronized boolean isDraftInitialized() {
        return draftState != null;
    }

    /** Wipe all draft state so a fresh draft can be started. */
    public synchronized void resetDraft() {
        draftState = null;
    }

    /**
     * Returns the Team currently on the clock based on the snake-draft order.
     * Odd rounds → ascending order. Even rounds → descending order.
     */
    public synchronized Team getCurrentPickingTeam() {
        if (draftState == null) return null;
        int numTeams = draftState.getTeams().size();
        int pick = draftState.getCurrentPick(); // 1-based
        int round = draftState.getRound();
        int idx;
        if (!draftState.isSnakeOrder() || round % 2 == 1) {
            idx = pick - 1; // ascending
        } else {
            idx = numTeams - pick; // descending
        }
        return draftState.getTeams().get(idx);
    }

    /**
     * Load keepers before the draft starts. Keepers are removed from the
     * available pool and assigned to their team rosters immediately.
     */
    public synchronized void loadKeepers(List<KeeperDTO> keepers) {
        if (draftState == null) {
            throw new IllegalStateException("Draft not initialized. Call /draft/initialize first.");
        }
        for (KeeperDTO k : keepers) {
            Team team = draftState.getTeams().stream()
                    .filter(t -> t.getName().equals(k.getTeamName()))
                    .findFirst().orElse(null);
            if (team == null) continue;

            // Find the player in the available pool
            Player keeperPlayer = draftState.getAvailablePlayers().stream()
                    .filter(p -> p.getId() == k.getPlayerId())
                    .findFirst().orElse(null);

            Keeper keeper = new Keeper();
            keeper.setPlayerId(k.getPlayerId());
            keeper.setTeamId(team.getId());
            keeper.setRound(k.getRound());
            team.getKeepers().add(keeper);

            // Remove from available pool and add to roster immediately
            if (keeperPlayer != null) {
                keeperPlayer.setKeeper(true);
                draftState.getAvailablePlayers().remove(keeperPlayer);
                team.getRoster().add(keeperPlayer);
            }
        }
    }

    /**
     * Submit a draft pick for a given player by the currently picking team.
     * The teamId is derived from the snake order automatically.
     */
    public synchronized Team makePick(int playerId) {
        if (draftState == null) {
            throw new IllegalStateException("Draft not initialized.");
        }
        Player picked = draftState.getAvailablePlayers().stream()
                .filter(p -> p.getId() == playerId)
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Player " + playerId + " not available."));

        Team currentTeam = getCurrentPickingTeam();

        draftState.getAvailablePlayers().remove(picked);
        draftState.getDraftedPlayers().add(picked);
        currentTeam.getRoster().add(picked);

        advanceDraft();
        return currentTeam;
    }

    /**
     * Advances the pick counter, handling snake-round wrapping.
     * Also skips any rounds that are fully occupied by keepers for all teams.
     */
    private void advanceDraft() {
        int numTeams = draftState.getTeams().size();
        int pick = draftState.getCurrentPick();
        int round = draftState.getRound();

        if (pick >= numTeams) {
            draftState.setRound(round + 1);
            draftState.setCurrentPick(1);
        } else {
            draftState.setCurrentPick(pick + 1);
        }
    }

    /**
     * Submit a pick by player name. Tries exact match first (case-insensitive),
     * then falls back to FuzzyMatcher scoring to handle typos, partial names,
     * and abbreviations (e.g. "mik tro" → "Mike Trout").
     */
    public synchronized Team makePickByName(String name) {
        if (draftState == null) {
            throw new IllegalStateException("Draft not initialized.");
        }
        String query = name.trim().toLowerCase();

        // 1. Exact match (fastest path)
        Player picked = draftState.getAvailablePlayers().stream()
                .filter(p -> p.getName().equalsIgnoreCase(name.trim()))
                .findFirst()
                .orElse(null);

        // 2. Fuzzy match — pick the highest-scoring candidate above threshold
        if (picked == null) {
            picked = draftState.getAvailablePlayers().stream()
                    .map(p -> new Object[]{p, FuzzyMatcher.score(p.getName().toLowerCase(), query)})
                    .filter(pair -> (double) pair[1] >= 0.4)
                    .max(Comparator.comparingDouble(pair -> (double) pair[1]))
                    .map(pair -> (Player) pair[0])
                    .orElseThrow(() -> new IllegalArgumentException(
                            "No available player found matching: " + name));
        }

        Team currentTeam = getCurrentPickingTeam();
        draftState.getAvailablePlayers().remove(picked);
        draftState.getDraftedPlayers().add(picked);
        currentTeam.getRoster().add(picked);
        advanceDraft();
        return currentTeam;
    }

    public synchronized DraftState getDraftState() {
        return draftState;
    }

    /**
     * Get the currently active scoring preset key for this draft session.
     * Defaults to "h2h_categories" if not set.
     */
    public synchronized String getActiveScoringPreset() {
        if (draftState == null) {
            throw new IllegalStateException("Draft not initialized.");
        }
        return draftState.getActiveScoringPreset();
    }

    /**
     * Set the active scoring preset for this draft session.
     * This affects all future recommendations calculations.
     */
    public synchronized void setActiveScoringPreset(String presetKey) {
        if (draftState == null) {
            throw new IllegalStateException("Draft not initialized.");
        }
        draftState.setActiveScoringPreset(presetKey);
    }

    /**
     * Undo the most recently submitted pick.
     * Removes the player from the drafted list and their team's roster,
     * returns them to the available pool, and reverses the pick counter.
     *
     * @return the player whose pick was undone
     */
    public synchronized Player undoLastPick() {
        if (draftState == null) throw new IllegalStateException("Draft not initialized.");
        List<Player> drafted = draftState.getDraftedPlayers();
        if (drafted.isEmpty()) throw new IllegalStateException("No picks to undo.");

        Player last = drafted.remove(drafted.size() - 1);

        // Return to top of available pool so they're visible immediately
        draftState.getAvailablePlayers().add(0, last);

        // Remove from whichever team's roster has them
        draftState.getTeams().forEach(t -> t.getRoster().remove(last));

        reverseDraft();
        return last;
    }

    /** Reverse the pick counter by one slot, handling round boundaries. */
    private void reverseDraft() {
        int numTeams = draftState.getTeams().size();
        int pick  = draftState.getCurrentPick();
        int round = draftState.getRound();
        if (pick <= 1) {
            if (round > 1) {
                draftState.setRound(round - 1);
                draftState.setCurrentPick(numTeams);
            }
        } else {
            draftState.setCurrentPick(pick - 1);
        }
    }
}
