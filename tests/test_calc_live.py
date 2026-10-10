import unittest

import lcu


def live_payload():
    return {
        "activePlayer": {
            "riotId": "Me#TW2",
            "level": 11,
            "currentGold": 1234.5,
            "championStats": {
                "attackDamage": 180.0, "abilityPower": 0.0, "attackSpeed": 1.2,
                "critChance": 0.25, "critDamage": 175.0,
                "physicalLethality": 18.0, "armorPenetrationPercent": 0.65,
                "magicPenetrationFlat": 0.0, "magicPenetrationPercent": 1.0,
                "abilityHaste": 20.0, "maxHealth": 2000.0, "armor": 80.0, "magicResist": 50.0,
                "resourceType": "MANA", "resourceMax": 900.0, "attackRange": 525.0,
            },
        },
        "allPlayers": [
            {"riotId": "Me#TW2", "team": "ORDER", "level": 11, "championName": "悟空",
             "rawChampionName": "game_character_displayname_MonkeyKing", "items": [{"itemID": 3071}, {"itemID": 3006}]},
            {"riotId": "Ally#TW2", "team": "ORDER", "level": 10, "championName": "安妮",
             "rawChampionName": "game_character_displayname_Annie", "items": []},
            {"riotId": "Foe#TW2", "team": "CHAOS", "level": 12, "championName": "蓋倫",
             "rawChampionName": "game_character_displayname_Garen", "items": [{"itemID": 3075}]},
        ],
        "gameData": {"gameTime": 600.0},
    }


class ParseLiveGameTests(unittest.TestCase):
    def test_stats_are_normalised_to_calculator_units(self):
        game = lcu.parse_live_game(live_payload())
        st = game["stats"]
        self.assertEqual(st["ad"], 180.0)
        self.assertEqual(st["critChance"], 25.0)  # 0.25 → 25%
        self.assertEqual(st["critDamage"], 1.75)  # 175 → 1.75 倍
        self.assertEqual(st["armorPenPct"], 35.0)  # 剩 0.65 → 無視 35%
        self.assertEqual(st["magicPenPct"], 0.0)
        self.assertEqual(st["lethality"], 18.0)
        self.assertEqual(game["level"], 11)
        self.assertEqual(st["mana"], 900.0)
        self.assertTrue(st["ranged"])

    def test_non_mana_resource_counts_as_no_mana(self):
        payload = live_payload()
        payload["activePlayer"]["championStats"].update(resourceType="ENERGY", resourceMax=200.0, attackRange=125.0)
        st = lcu.parse_live_game(payload)["stats"]
        self.assertEqual(st["mana"], 0.0)
        self.assertFalse(st["ranged"])

    def test_players_carry_team_side_and_items_but_no_names(self):
        game = lcu.parse_live_game(live_payload())
        me, ally, foe = game["players"]
        self.assertTrue(me["isMe"] and me["ally"])
        self.assertEqual(me["champion"], "MonkeyKing")
        self.assertEqual(me["items"], [3071, 3006])
        self.assertTrue(ally["ally"] and not ally["isMe"])
        self.assertFalse(foe["ally"])
        for p in game["players"]:
            self.assertNotIn("riotId", p)
            self.assertNotIn("summonerName", p)
            self.assertFalse(any("#TW2" in str(v) for v in p.values()))

    def test_empty_payload_means_not_in_game(self):
        self.assertIsNone(lcu.parse_live_game({}))


class ItemStatParserTests(unittest.TestCase):
    def test_percent_magic_pen_is_kept_apart_from_flat(self):
        self.assertEqual(lcu._item_stats("<stats>95 魔法攻擊<br><attention>40%</attention> 魔法穿透</stats>"),
                         {"AbilityPower": 95.0, "MagicPenetrationPercent": 40.0})
        self.assertEqual(lcu._item_stats("<stats>12 魔法穿透<br>45 跑速</stats>"),
                         {"MagicPenetration": 12.0, "MoveSpeed": 45.0})

    def test_armor_pen_stays_under_one_key(self):
        self.assertEqual(lcu._item_stats("<stats>35 物理攻擊<br>35% 物理穿透</stats>"),
                         {"AttackDamage": 35.0, "ArmorPenetration": 35.0})


if __name__ == "__main__":
    unittest.main()
