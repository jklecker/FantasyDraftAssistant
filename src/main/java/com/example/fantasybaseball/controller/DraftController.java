package com.example.fantasybaseball.controller;

import com.example.fantasybaseball.config.ScoringConfigLoader;
import com.example.fantasybaseball.config.ScoringPreset;
import com.example.fantasybaseball.dto.InitializeDraftRequest;
import com.example.fantasybaseball.dto.KeeperRequest;
import com.example.fantasybaseball.model.DraftState;
import com.example.fantasybaseball.model.Player;
import com.example.fantasybaseball.model.Team;
import com.example.fantasybaseball.model.TeamStats;
import com.example.fantasybaseball.service.DraftService;
import com.example.fantasybaseball.service.FootballPlayerService;
import com.example.fantasybaseball.service.PlayerPoolService;
import com.example.fantasybaseball.service.ScoringService;
import com.example.fantasybaseball.util.FuzzyMatcher;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/draft")
public class DraftController {

    @Autowired
    private DraftService draftService;

    @Autowired
    private PlayerPoolService playerPoolService;

    @Autowired
    private ScoringService scoringService;

    @Autowired
    private ScoringConfigLoader scoringConfigLoader;

    @Autowired
    private FootballPlayerService footballPlayerService;

    /**
     * Initialize the draft with a list of team names and snake-order flag.
     * Example body:
     * { "teamNames": ["Team A","Team B",...], "snakeOrder": true }
     */
    @PostMapping("/initialize")
    public ResponseEntity<DraftState> initialize(@RequestBody InitializeDraftRequest request) {
        List<Player> players = playerPoolService.getAllPlayers();
        List<Team> teams = new ArrayList<>();
        for (int i = 0; i < request.getTeamNames().size(); i++) {
            Team t = new Team();
            t.setId(i + 1);
            t.setName(request.getTeamNames().get(i));
            teams.add(t);
        }
        draftService.initializeDraft(teams, players, request.isSnakeOrder());
        draftService.getDraftState().setSport("baseball");
        return ResponseEntity.ok(draftService.getDraftState());
    }

    /**
     * Submit the next pick in draft order (snake order auto-determines which team).
     * Supply either playerId (integer) OR playerName (string) — name is matched
     * case-insensitively against the available player pool as a fallback.
     */
    @PostMapping("/pick")
    public ResponseEntity<Map<String, Object>> pick(
            @RequestParam(required = false) Integer playerId,
            @RequestParam(required = false) String playerName) {
        requireInitialized();
        if (playerId == null && (playerName == null || playerName.isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Provide either playerId or playerName");
        }
        try {
            Team team = (playerId != null)
                    ? draftService.makePick(playerId)
                    : draftService.makePickByName(playerName);
            DraftState state = draftService.getDraftState();
            return ResponseEntity.ok(Map.of(
                    "pickedByTeam", team.getName(),
                    "round", state.getRound(),
                    "nextPick", state.getCurrentPick()
            ));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    /**
     * Auto-initialize the draft with default team names (Team 1..N)
     * and snake order. If the draft is already initialized this is a no-op and
     * just returns the current state — safe to call on every page load.
     */
    @PostMapping("/auto-initialize")
    public ResponseEntity<DraftState> autoInitialize(
            @RequestParam(defaultValue = "12") int numTeams,
            @RequestParam(defaultValue = "baseball") String sport) {
        boolean sportMismatch = draftService.isDraftInitialized()
                && !sport.equalsIgnoreCase(draftService.getDraftState().getSport());
        if (!draftService.isDraftInitialized() || sportMismatch) {
            List<Player> players = "football".equalsIgnoreCase(sport)
                    ? footballPlayerService.getPlayers()
                    : playerPoolService.getAllPlayers();
            List<Team> teams = new ArrayList<>();
            for (int i = 1; i <= numTeams; i++) {
                Team t = new Team();
                t.setId(i);
                t.setName("Team " + i);
                teams.add(t);
            }
            draftService.initializeDraft(teams, players, true);
            draftService.getDraftState().setSport(sport.toLowerCase());
        }
        return ResponseEntity.ok(draftService.getDraftState());
    }

    /**
     * Get top 5 recommendations for a specific team.
     * Factors in: BPA category score, team stat needs, positional scarcity, late-round upside.
     * Uses the active preset from this draft session.
     */
    @GetMapping("/recommendations")
    public List<Player> recommendations(@RequestParam int teamId,
                                        @RequestParam(defaultValue = "1") int round,
                                        @RequestParam(defaultValue = "15") int limit) {
        requireInitialized();
        DraftState state = draftService.getDraftState();

        Team team = state.getTeams().stream()
                .filter(t -> t.getId() == teamId)
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Team " + teamId + " not found"));

        TeamStats stats = TeamStats.fromTeam(team);
        String presetKey = draftService.getActiveScoringPreset();
        return scoringService.recommendPlayers(
                state.getAvailablePlayers(), stats, team, round, limit, presetKey);
    }

    /**
     * Expanded recommendation board for draft decisions:
     * - overall: top N regardless of role
     * - pitchers: top N SP/RP options
     * - batters: top N non-pitchers
     * Uses the active preset from this draft session.
     */
    @GetMapping("/recommendations/board")
    public Map<String, List<Player>> recommendationBoard(
            @RequestParam int teamId,
            @RequestParam(defaultValue = "1") int round,
            @RequestParam(defaultValue = "15") int overallLimit,
            @RequestParam(defaultValue = "10") int pitcherLimit,
            @RequestParam(defaultValue = "10") int batterLimit) {
        requireInitialized();
        DraftState state = draftService.getDraftState();

        Team team = state.getTeams().stream()
                .filter(t -> t.getId() == teamId)
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Team " + teamId + " not found"));

        TeamStats stats = TeamStats.fromTeam(team);
        String presetKey = draftService.getActiveScoringPreset();
        return Map.of(
                "overall", scoringService.recommendPlayers(state.getAvailablePlayers(), stats, team, round, overallLimit, presetKey),
                "pitchers", scoringService.recommendPitchers(state.getAvailablePlayers(), stats, team, round, pitcherLimit, presetKey),
                "batters", scoringService.recommendBatters(state.getAvailablePlayers(), stats, team, round, batterLimit, presetKey)
        );
    }

    /**
     * Returns which roster positions the team still needs to fill and how many.
     * e.g. {"C":1, "OF":2, "SP":1}
     */
    @GetMapping("/positional-needs")
    public Map<String, Integer> positionalNeeds(@RequestParam int teamId) {
        requireInitialized();
        DraftState state = draftService.getDraftState();
        Team team = state.getTeams().stream()
                .filter(t -> t.getId() == teamId)
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Team " + teamId + " not found"));
        return scoringService.getPositionalDeficits(team);
    }

    /**
     * Search available players by name using fuzzy matching.
     * Supports exact substrings, word prefixes, character subsequences, and
     * edit-distance typo tolerance (1–2 character errors).
     * Results are returned sorted by match quality (best first).
     * If no query is supplied the full available pool is returned.
     */
    @GetMapping("/players")
    public List<Player> searchPlayers(@RequestParam(required = false) String q) {
        requireInitialized();
        List<Player> available = draftService.getDraftState().getAvailablePlayers();
        if (q == null || q.isBlank()) return available;
        String lower = q.trim().toLowerCase();
        return available.stream()
                .map(p -> Map.entry(p, FuzzyMatcher.score(p.getName().toLowerCase(), lower)))
                .filter(e -> e.getValue() > 0.0)
                .sorted(Map.Entry.<Player, Double>comparingByValue().reversed())
                .map(Map.Entry::getKey)
                .collect(Collectors.toList());
    }

    /**
     * Returns full draft state: round, current pick, all rosters, available players.
     */
    @GetMapping("/state")
    public ResponseEntity<DraftState> state() {
        requireInitialized();
        return ResponseEntity.ok(draftService.getDraftState());
    }

    /**
     * Returns the team currently on the clock.
     */
    @GetMapping("/current-team")
    public ResponseEntity<Team> currentTeam() {
        requireInitialized();
        return ResponseEntity.ok(draftService.getCurrentPickingTeam());
    }

    /**
     * Reset the draft completely — wipes all picks, rosters, and keepers.
     * The next call to /draft/initialize or /draft/auto-initialize starts fresh.
     */
    @PostMapping("/reset")
    public ResponseEntity<Map<String, String>> reset() {
        draftService.resetDraft();
        return ResponseEntity.ok(Map.of("status", "reset", "message", "Draft cleared. Call /draft/initialize to start a new draft."));
    }

    /**
     * Undo the last submitted pick: returns the player to the available pool,
     * removes them from the team roster, and reverses the pick counter.
     */
    @PostMapping("/undo")
    public ResponseEntity<Map<String, Object>> undoLastPick() {
        requireInitialized();
        try {
            Player undone = draftService.undoLastPick();
            DraftState state = draftService.getDraftState();
            return ResponseEntity.ok(Map.of(
                    "undonePlayer", undone.getName(),
                    "round", state.getRound(),
                    "currentPick", state.getCurrentPick()
            ));
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    /**
     * Load keepers before the draft. Each keeper is removed from the pool
     * and placed on the team's roster. Example body:
     * { "keepers": [{"teamName":"Team A","playerId":1,"round":2},...] }
     */
    @PostMapping("/load-keepers")
    public ResponseEntity<DraftState> loadKeepers(@RequestBody KeeperRequest request) {
        requireInitialized();
        try {
            draftService.loadKeepers(request.getKeepers());
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        return ResponseEntity.ok(draftService.getDraftState());
    }

    /**
     * Get all available scoring presets.
     * Returns a list of preset metadata (name, type, description).
     */
    @GetMapping("/scoring/presets")
    public ResponseEntity<List<Map<String, String>>> getAvailableScoringPresets() {
        List<Map<String, String>> presets = new ArrayList<>();
        for (String presetKey : scoringConfigLoader.getAvailablePresets()) {
            ScoringPreset preset = scoringConfigLoader.getPreset(presetKey);
            if (preset != null) {
                Map<String, String> info = new HashMap<>();
                info.put("key", presetKey);
                info.put("name", preset.getName());
                info.put("type", preset.getType());
                info.put("description", preset.getDescription());
                presets.add(info);
            }
        }
        return ResponseEntity.ok(presets);
    }

    /**
     * Get the currently active scoring preset with full details.
     * Returns the preset configuration including batting/pitching weights.
     */
    @GetMapping("/scoring/active")
    public ResponseEntity<Map<String, Object>> getActiveScoringPreset() {
        ScoringPreset activePreset = scoringConfigLoader.getActivePreset();
        if (activePreset == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "No active scoring preset configured");
        }
        
        Map<String, Object> response = new HashMap<>();
        response.put("activePresetKey", scoringConfigLoader.getActivePreset());
        response.put("name", activePreset.getName());
        response.put("type", activePreset.getType());
        response.put("description", activePreset.getDescription());
        response.put("batting", activePreset.getBatting());
        response.put("pitching", activePreset.getPitching());
        response.put("teamNeedAdjustments", activePreset.getTeamNeedAdjustments());
        
        return ResponseEntity.ok(response);
    }

    /**
     * Get the currently active scoring preset for THIS DRAFT SESSION.
     * Returns the preset key and its details (batting weights, pitching weights, etc).
     * Example: GET /draft/scoring/active-session
     */
    @GetMapping("/scoring/active-session")
    public ResponseEntity<Map<String, Object>> getActiveScoringPresetForSession() {
        requireInitialized();
        String presetKey = draftService.getActiveScoringPreset();
        ScoringPreset preset = scoringConfigLoader.getPreset(presetKey);
        
        if (preset == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Scoring preset '" + presetKey + "' configured for session but not found in config");
        }

        Map<String, Object> response = new HashMap<>();
        response.put("activePresetKey", presetKey);
        response.put("name", preset.getName());
        response.put("type", preset.getType());
        response.put("description", preset.getDescription());
        response.put("batting", preset.getBatting());
        response.put("pitching", preset.getPitching());
        response.put("teamNeedAdjustments", preset.getTeamNeedAdjustments());
        
        return ResponseEntity.ok(response);
    }

    /**
     * Set the active scoring preset for THIS DRAFT SESSION.
     * Example: POST /draft/scoring/set-preset?presetKey=espn_points_10team
     * This changes the preset ONLY for this draft session, not globally.
     * All future recommendations will use the new preset.
     */
    @PostMapping("/scoring/set-preset")
    public ResponseEntity<Map<String, Object>> setActiveScoringPresetForSession(
            @RequestParam String presetKey) {
        requireInitialized();
        
        if (!scoringConfigLoader.hasPreset(presetKey)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Scoring preset '" + presetKey + "' not found");
        }
        
        draftService.setActiveScoringPreset(presetKey);
        ScoringPreset newPreset = scoringConfigLoader.getPreset(presetKey);
        
        Map<String, Object> response = new HashMap<>();
        response.put("activePresetKey", presetKey);
        response.put("name", newPreset.getName());
        response.put("type", newPreset.getType());
        response.put("message", "Scoring preset changed for this draft session. Recommendations will update.");
        
        return ResponseEntity.ok(response);
    }

    /**
     * Set the global active scoring preset (affects the config file).
     * Example: POST /draft/scoring/set-active?presetKey=espn_points_10team
     * After setting, all future recommendations will use the new preset.
     */
    @PostMapping("/scoring/set-active")
    public ResponseEntity<Map<String, String>> setActiveScoringPreset(
            @RequestParam String presetKey) {
        if (!scoringConfigLoader.hasPreset(presetKey)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Scoring preset '" + presetKey + "' not found");
        }
        
        scoringConfigLoader.setActivePreset(presetKey);
        ScoringPreset newActive = scoringConfigLoader.getActivePreset();
        
        Map<String, String> response = new HashMap<>();
        response.put("activePreset", presetKey);
        response.put("name", newActive.getName());
        response.put("message", "Scoring preset changed successfully. Recommendations will update.");
        
        return ResponseEntity.ok(response);
    }

    private void requireInitialized() {
        if (!draftService.isDraftInitialized()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Draft not initialized. POST /draft/initialize first.");
        }
    }
}
