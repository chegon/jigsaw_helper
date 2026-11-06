from __future__ import annotations

import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class AppTests(unittest.TestCase):
    def test_demo_workflow_and_stale_result_invalidation(self) -> None:
        app_path = Path(__file__).resolve().parents[1] / "app.py"
        app = AppTest.from_file(str(app_path), default_timeout=60).run()
        self.assertEqual(len(app.exception), 0)
        self.assertTrue(app.button[0].disabled)
        app.sidebar.checkbox[0].check().run()
        self.assertFalse(app.button[0].disabled)
        app.button[0].click().run()
        self.assertEqual(len(app.exception), 0)
        self.assertEqual(len(app.error), 0)
        self.assertEqual([metric.value for metric in app.metric], ["4", "4", "4"])
        self.assertEqual(len(app.dataframe[0].value), 4)
        self.assertEqual(int(app.dataframe[0].value["邻接轮廓分 / 100"].isna().sum()), 1)
        self.assertEqual(len(app.get("download_button")), 2)
        app.sidebar.slider[0].set_value(35).run()
        self.assertEqual(len(app.exception), 0)
        self.assertEqual(len(app.metric), 0)
        self.assertNotIn("analysis", app.session_state)


if __name__ == "__main__":
    unittest.main()
