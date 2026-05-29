package com.example.fantasybaseball;

import com.example.fantasybaseball.model.Player;
import com.example.fantasybaseball.service.CbsRankingsService;
import com.example.fantasybaseball.service.EspnAdpService;
import com.example.fantasybaseball.service.FantasyProsService;
import com.example.fantasybaseball.service.NflDataMergeService;
import com.example.fantasybaseball.service.NflPlayerService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class NflDataMergeServiceTest {

    @Mock NflPlayerService   sleeperSvc;
    @Mock FantasyProsService fpSvc;
    @Mock EspnAdpService     espnSvc;
    @Mock CbsRankingsService cbsSvc;
    @InjectMocks NflDataMergeService mergeService;

    private NflPlayerService.SleeperPlayer sleeperPlayer(String name, String team, String pos) {
        NflPlayerService.SleeperPlayer p = new NflPlayerService.SleeperPlayer();
        p.fullName = name; p.team = team; p.position = pos;
        p.active = true; p.yearsExp = 3;
        return p;
    }

    private FantasyProsService.FpRanking fpRanking(String name, String team, String pos, int rank) {
        FantasyProsService.FpRanking r = new FantasyProsService.FpRanking();
        r.name = name; r.team = team; r.position = pos; r.rank = rank; r.adp = rank;
        return r;
    }

    private FantasyProsService.FpProjection fpProjection(String name, String pos, double pts) {
        FantasyProsService.FpProjection p = new FantasyProsService.FpProjection();
        p.name = name; p.position = pos; p.fantasyPoints = pts;
        p.stats = Map.of("recYards", 1200.0, "receptions", 90.0, "recTD", 8.0);
        return p;
    }

    @BeforeEach void stubDefaults() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of());
        when(fpSvc.getRankings(anyString())).thenReturn(List.of());
        when(fpSvc.getProjections(anyString())).thenReturn(List.of());
        when(espnSvc.getRankings(anyString())).thenReturn(List.of());
        when(cbsSvc.getRankings(anyString())).thenReturn(List.of());
    }

    @Test void exactNameMatchAttachesRankAndProjection() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(sleeperPlayer("CeeDee Lamb", "DAL", "WR")));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("CeeDee Lamb", "DAL", "WR", 1)));
        when(fpSvc.getProjections("ppr")).thenReturn(List.of(fpProjection("CeeDee Lamb", "WR", 350.0)));

        List<Player> result = mergeService.getMergedPlayers("ppr");

        assertThat(result).hasSize(1);
        Player p = result.get(0);
        assertThat(p.getAdp()).isEqualTo(1.0);
        assertThat(p.getNextGen()).containsKey("projectedPoints");
        assertThat(p.getNextGen().get("projectedPoints")).isEqualTo(350.0);
    }

    @Test void apostropheVariantMatches() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(sleeperPlayer("Ja'Marr Chase", "CIN", "WR")));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("JaMarr Chase", "CIN", "WR", 3)));
        when(fpSvc.getProjections("ppr")).thenReturn(List.of());

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getAdp()).isEqualTo(3.0);
    }

    @Test void jrSuffixVariantMatches() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(sleeperPlayer("Travis Kelce", "KC", "TE")));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("Travis Kelce Jr.", "KC", "TE", 8)));
        when(fpSvc.getProjections("ppr")).thenReturn(List.of());

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getAdp()).isEqualTo(8.0);
    }

    @Test void dstPositionNormalized() {
        NflPlayerService.SleeperPlayer def = sleeperPlayer("San Francisco 49ers", "SF", "DEF");
        when(sleeperSvc.getPlayers()).thenReturn(List.of(def));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("San Francisco 49ers D/ST","SF","DST",45)));
        when(fpSvc.getProjections("ppr")).thenReturn(List.of());

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getPosition()).isEqualTo("DST");
        assertThat(result.get(0).getAdp()).isEqualTo(45.0);
    }

    @Test void fpOnlyPlayerIncludedIfRankedHighEnough() {
        // Not in Sleeper, but ranked 50 in FP
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("New Player", "DAL", "WR", 50)));

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getName()).isEqualTo("New Player");
    }

    @Test void fpOnlyPlayerExcludedIfRankedTooLow() {
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("Late Bench", "GB", "WR", 300)));

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).isEmpty();
    }

    @Test void noDuplicatePlayers() {
        // Same player in both Sleeper and FP — should appear once
        when(sleeperSvc.getPlayers()).thenReturn(List.of(sleeperPlayer("Josh Allen", "BUF", "QB")));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(fpRanking("Josh Allen", "BUF", "QB", 2)));
        when(fpSvc.getProjections("ppr")).thenReturn(List.of());

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
    }

    @Test void sortedByAdpAscending() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(
            sleeperPlayer("Player A", "KC", "WR"),
            sleeperPlayer("Player B", "DAL", "RB")
        ));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(
            fpRanking("Player A", "KC", "WR", 5),
            fpRanking("Player B", "DAL", "RB", 2)
        ));

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result.get(0).getName()).isEqualTo("Player B");
        assertThat(result.get(1).getName()).isEqualTo("Player A");
    }

    @Test void overallAndPositionRanksAssigned() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(
            sleeperPlayer("WR One", "KC", "WR"),
            sleeperPlayer("WR Two", "DAL", "WR"),
            sleeperPlayer("QB One", "BUF", "QB")
        ));
        when(fpSvc.getRankings("ppr")).thenReturn(List.of(
            fpRanking("WR One", "KC", "WR", 1),
            fpRanking("QB One", "BUF", "QB", 2),
            fpRanking("WR Two", "DAL", "WR", 3)
        ));

        List<Player> result = mergeService.getMergedPlayers("ppr");
        Player wr1 = result.stream().filter(p -> p.getName().equals("WR One")).findFirst().orElseThrow();
        Player wr2 = result.stream().filter(p -> p.getName().equals("WR Two")).findFirst().orElseThrow();

        assertThat(wr1.getNextGen().get("overallRank")).isEqualTo(1.0);
        assertThat(wr2.getNextGen().get("overallRank")).isEqualTo(3.0);
        // WR One is posRank 1, WR Two is posRank 2
        assertThat(wr1.getNextGen().get("posRank")).isEqualTo(1.0);
        assertThat(wr2.getNextGen().get("posRank")).isEqualTo(2.0);
    }

    @Test void sleeperOnlyPlayerIncludedWithNullAdp() {
        when(sleeperSvc.getPlayers()).thenReturn(List.of(sleeperPlayer("Obscure Player", "TB", "RB")));

        List<Player> result = mergeService.getMergedPlayers("ppr");
        assertThat(result).hasSize(1);
        // No FP match — ADP will be null, sorted to end
        assertThat(result.get(0).getName()).isEqualTo("Obscure Player");
    }
}
