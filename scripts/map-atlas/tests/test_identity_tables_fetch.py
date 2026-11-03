import json
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from mapatlas.csvtables import SchemaError, read_table, to_int
from mapatlas.fetch import fetch_tables, table_url
from mapatlas.identity import IdentityError, parse_build_info, read_identity, select_identity

HEADER = "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0"


def build_info(*rows):
    return "\n".join([HEADER, *rows]) + "\n"


KEY = "0123456789abcdef0123456789ABCDEF"


class IdentityTests(unittest.TestCase):
    def test_reads_active_row_for_the_forever_product(self):
        rows = parse_build_info(build_info(f"eu|1|{KEY}|cdn|1.60.1.70450|wow_classic_beta", f"eu|1|{KEY}|cdn|1.15.0.60000|wow_classic_era"))
        ident = select_identity(rows)
        self.assertEqual((ident.product, ident.version, ident.build_number), ("wow_classic_beta", "1.60.1.70450", 70450))
        self.assertEqual(ident.to_json()["buildKey"], KEY.lower())

    def test_never_substitutes_another_product(self):
        rows = parse_build_info(build_info(f"eu|1|{KEY}|cdn|1.15.0.60000|wow_classic_era"))
        with self.assertRaisesRegex(IdentityError, "wow_classic_beta.*not present"):
            select_identity(rows)

    def test_ambiguous_or_inactive_is_refused(self):
        two = parse_build_info(build_info(f"eu|1|{KEY}|c|1.60.1.70450|wow_classic_beta", f"us|1|{KEY}|c|1.60.1.70451|wow_classic_beta"))
        with self.assertRaisesRegex(IdentityError, "2 active"):
            select_identity(two)
        none = parse_build_info(build_info(f"eu|0|{KEY}|c|1.60.1.70450|wow_classic_beta"))
        with self.assertRaisesRegex(IdentityError, "0 active"):
            select_identity(none)

    def test_validates_version_and_key(self):
        for row in (f"eu|1|{KEY}|c|60.1|wow_classic_beta", f"eu|1|zz|c|1.60.1.70450|wow_classic_beta"):
            with self.assertRaises(IdentityError):
                select_identity(parse_build_info(build_info(row)))

    def test_finds_build_info_in_install_root_or_flavour_folder_and_checks_expected_version(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "_classic_beta_").mkdir()
            (root / ".build.info").write_text(build_info(f"eu|1|{KEY}|c|1.60.1.70450|wow_classic_beta"))
            self.assertEqual(read_identity(root / "_classic_beta_").version, "1.60.1.70450")
            self.assertEqual(read_identity(root, expect_version="1.60.1.70450").version, "1.60.1.70450")
            with self.assertRaisesRegex(IdentityError, "expected 1.60.1.70451"):
                read_identity(root, expect_version="1.60.1.70451")
        with tempfile.TemporaryDirectory() as other:
            with self.assertRaises(IdentityError):
                read_identity(Path(other) / "nowhere")


class TableTests(unittest.TestCase):
    def write(self, text):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = Path(self.tmp.name) / "T.csv"
        p.write_text(text, encoding="utf-8")
        return p

    def test_columns_are_found_by_name_not_position_and_aliases_work(self):
        p = self.write("﻿Name,ParentUiMapID,Type,ID\nKalimdor,947,2,1414\n")
        t = read_table(p, "UiMap", [("ID", ()), ("Name_lang", ("Name",)), ("ParentUiMapID", ()), ("Type", ())])
        self.assertEqual(t.rows, [{"ID": "1414", "Name_lang": "Kalimdor", "ParentUiMapID": "947", "Type": "2"}])

    def test_missing_required_column_fails_loudly_and_ragged_rows_are_counted(self):
        with self.assertRaisesRegex(SchemaError, "required column 'Type'"):
            read_table(self.write("ID,Name_lang,ParentUiMapID\n1,a,0\n"), "UiMap", [("ID", ()), ("Type", ())])
        t = read_table(self.write("ID,Type\n1,2\n3\n4,5\n"), "UiMap", [("ID", ()), ("Type", ())])
        self.assertEqual((len(t), t.bad_rows), (2, 1))

    def test_to_int(self):
        self.assertEqual((to_int("12"), to_int(""), to_int("3.0"), to_int(None, 7)), (12, 0, 3, 7))
        with self.assertRaises(SchemaError):
            to_int("1.5")


class FetchTests(unittest.TestCase):
    def test_url_shape_matches_the_companion_and_rejects_bad_input(self):
        self.assertEqual(table_url("UiMap", "1.60.1.70450"), "https://wago.tools/db2/UiMap/csv?build=1.60.1.70450")
        with self.assertRaises(ValueError):
            table_url("UiMap", "latest")
        with self.assertRaises(ValueError):
            table_url("Item", "1.60.1.70450")

    def test_writes_exports_with_hashes_and_refuses_foreign_redirects(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            src = fetch_tables("1.60.1.70450", out, ["UiMap"], opener=lambda u: (u, b"ID\n1\n"))
            self.assertEqual((out / "UiMap.csv").read_bytes(), b"ID\n1\n")
            self.assertEqual(json.loads((out / "_sources.json").read_text())["tables"]["UiMap"]["sha256"], src["UiMap"]["sha256"])
            for bad in ("http://wago.tools/x", "https://evil.example/x"):
                with self.assertRaisesRegex(ValueError, "refusing"):
                    fetch_tables("1.60.1.70450", out, ["UiMap"], opener=lambda u, b=bad: (b, b"x"))


if __name__ == "__main__":
    unittest.main()
