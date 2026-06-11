package com.example.fantasybaseball.model;

/**
 * A single pick in the shared football draft board.
 * Immutable data sent from the client — the client computes teamSlot and overall
 * based on its snake-order logic; the server just stores and broadcasts them.
 */
public class FootballPick {
    private int playerId;
    private int teamSlot;
    private int overall;

    public FootballPick() {}

    public FootballPick(int playerId, int teamSlot, int overall) {
        this.playerId = playerId;
        this.teamSlot = teamSlot;
        this.overall = overall;
    }

    public int getPlayerId()  { return playerId; }
    public int getTeamSlot()  { return teamSlot; }
    public int getOverall()   { return overall; }

    public void setPlayerId(int playerId)  { this.playerId = playerId; }
    public void setTeamSlot(int teamSlot)  { this.teamSlot = teamSlot; }
    public void setOverall(int overall)    { this.overall = overall; }
}
