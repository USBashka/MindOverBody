#!/usr/bin/env python3
"""Opt-in native document smoke, including the standard release APK smoke first.

ANDROID_SERIAL=emulator-5554 python3 scripts/check-android-files.py --native-files

Uses Android DocumentsUI for both ACTION_OPEN_DOCUMENT and ACTION_CREATE_DOCUMENT;
no injected JavaScript, debug WebView, Google login, or real diary data is used.
Run on a dedicated emulator. Each run uses a uniquely named synthetic fixture;
existing application data is retained. Without --native-files this runs only the
unchanged standard smoke.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("mob_android_smoke", ROOT / "scripts/check-android.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def first_node(tree, choices, *, editable=False, exact=False):
    for choice in choices:
        node = base.find_node(tree, choice, editable=editable, exact=exact)
        if node is not None:
            return node
    return None


def document_nodes(tree):
    return [node for node in tree.iter("node")
            if "documentsui" in node.get("package", "") and base.bounds(node)
            and node.get("enabled") != "false"]


class FileSmoke(base.Smoke):
    def wait_any(self, choices, *, exact=False, editable=False, seconds=60):
        deadline = time.monotonic() + min(seconds, 60)
        while time.monotonic() < deadline:
            try:
                tree = self.dump(timeout=min(15, deadline - time.monotonic()))
                node = first_node(tree, choices, exact=exact, editable=editable)
                if node is not None:
                    return node
            except (RuntimeError, subprocess.TimeoutExpired, ET.ParseError):
                pass
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError("No visible document control matched: " + ", ".join(choices))

    def wait_documents(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.dump(timeout=min(15, deadline - time.monotonic()))
            if document_nodes(self.tree):
                return
            # ACTION_OPEN_DOCUMENT wrapped in a chooser can briefly show the
            # Android resolver; choose the system Files application if needed.
            chooser = first_node(self.tree, ("Files", "Файлы", "Just once", "JUST ONCE", "Только сейчас", "Только один раз"), exact=True)
            if chooser is not None and deadline - time.monotonic() > 5:
                self.tap(chooser)
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError("The system DocumentsUI did not open within 60s")

    def wait_mob_view(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.dump(timeout=min(15, deadline - time.monotonic()))
            if any(node.get("class") == "android.webkit.WebView"
                   and node.get("package") == base.PACKAGE
                   and base.bounds(node) for node in self.tree.iter("node")):
                return
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError("DocumentsUI did not return to MOB's WebView within 60s")

    def downloads(self):
        self.wait_documents()
        labels = ("Downloads", "Загрузки", "Скачанные файлы")
        download = first_node(self.tree, labels, exact=True)
        if download is None:
            roots = first_node(self.tree, (
                "Show roots", "Open navigation drawer", "Показать корни",
                "Показать корневые каталоги", "Открыть панель навигации", "android:id/home",
            ))
            if roots is None:
                # AOSP and Google DocumentsUI use a toolbar ImageButton for the
                # drawer. Select its leftmost visible button from actual XML.
                buttons = [node for node in document_nodes(self.tree)
                           if node.get("class", "").endswith("ImageButton")
                           and node.get("clickable") == "true"]
                roots = min(buttons, key=lambda node: (base.bounds(node)[1], base.bounds(node)[0])) if buttons else None
            if roots is None:
                raise RuntimeError("DocumentsUI navigation drawer is not accessible")
            self.tap(roots)
            download = self.wait_any(labels, exact=True, seconds=30)
        self.tap(download)
        self.wait_any(labels, exact=True, seconds=30)

    def hide_keyboard(self):
        keyboard = self.adb("shell", "dumpsys", "input_method")
        if re.search(r"(?:mInputShown|mIsInputViewShown|isInputViewShown)=true", keyboard):
            self.adb("shell", "input", "keyevent", "KEYCODE_BACK")

    def native_files(self):
        fixture = [{"text": "MOB native file smoke " + self.title, "timestamp": 1767268800, "tags": []}]
        fixture_path = self.artifacts / "mob-native-import.json"
        fixture_path.write_text(json.dumps(fixture) + "\n")
        remote_fixture = "/sdcard/Download/mob-native-import.json"
        self.adb("shell", "mkdir", "-p", "/sdcard/Download")
        self.adb("push", str(fixture_path), remote_fixture)
        self.adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file://" + remote_fixture, check=False)

        self.launch()
        self.wait_text("Между сном и явью")
        self.tap(self.wait_text("Настройки", exact=True))
        self.wait_text("Настройки пространства")
        self.tap(self.seek_text("Импорт Somnio или MOB"))
        self.downloads()
        self.tap(self.wait_text("mob-native-import.json", exact=True))
        self.wait_text("Импорт дневника")
        self.wait_text("Somnio: 1 новых")
        self.screenshot("06-native-import-preview")
        self.verified("The system document picker supplies a readable content URI and MOB previews one synthetic Somnio entry")
        self.tap(self.wait_text("Импортировать", exact=True))
        self.seek_text("Настройки пространства", downward=True)

        self.tap(self.seek_text("Скачать резервную копию JSON"))
        self.downloads()
        name_input = first_node(self.tree, (":id/display_name", ":id/name", "android:id/text1"), editable=True)
        if name_input is None:
            editable = [node for node in document_nodes(self.tree) if node.get("class", "").endswith("EditText")]
            if len(editable) != 1:
                raise RuntimeError("DocumentsUI export filename field is not unambiguous")
            name_input = editable[0]
        filename = "mob-native-export-" + self.title.removeprefix("MOB-Android-smoke-") + ".json"
        self.tap(name_input)
        self.adb("shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A")
        self.adb("shell", "input", "text", filename)
        self.wait_text(filename, editable=True, exact=True)
        self.hide_keyboard()
        self.tap(self.wait_any(("Save", "SAVE", "Сохранить", "СОХРАНИТЬ", "com.android.documentsui:id/action_menu_save", "com.google.android.documentsui:id/action_menu_save"), exact=True))
        self.wait_mob_view()

        destination = self.artifacts / filename
        deadline = time.monotonic() + 60
        backup = None
        while time.monotonic() < deadline:
            self.adb("pull", "/sdcard/Download/" + filename, str(destination), timeout=min(10, deadline - time.monotonic()), check=False)
            try:
                candidate = json.loads(destination.read_text())
                if (candidate.get("version") == 1
                    and any(entry.get("body") == fixture[0]["text"] and entry.get("source", {}).get("app") == "somnio" for entry in candidate.get("entries", []))
                    and any(entry.get("title") == self.title for entry in candidate.get("entries", []))):
                    backup = candidate
                    break
            except (OSError, ValueError, AttributeError, TypeError):
                pass
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        if backup is None:
            raise RuntimeError("The saved Downloads JSON did not contain both the imported Somnio fixture and the synthetic diary entry within 60s")
        self.screenshot("07-native-export-complete")
        self.verified("Android CREATE_DOCUMENT writes a valid Downloads JSON backup containing the confirmed Somnio import and saved diary entry")

    def run(self):
        super().run()
        if self.args.native_files:
            self.native_files()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-files", action="store_true", help="Exercise the real Android document picker and export destination")
    parser.add_argument("--apk", type=Path, default=Path(os.environ.get("APK", ROOT / "distributions/MOB-1.0.1.apk")))
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts/android")
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"))
    parser.add_argument("--adb", default=os.environ.get("ADB", "adb"))
    smoke = FileSmoke(parser.parse_args())
    failure = None
    try:
        smoke.run()
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ET.ParseError) as error:
        failure = str(error)
        print("ANDROID SMOKE FAILED: " + failure, file=sys.stderr, flush=True)
    finally:
        smoke.diagnostics()
        (smoke.artifacts / "result.json").write_text(json.dumps({
            "passed": failure is None, "failure": failure, "verified": smoke.checks,
            "serial": smoke.serial, "apk": str(smoke.args.apk.resolve()),
            "syntheticEntry": smoke.title, "nativeFilesRequested": smoke.args.native_files,
            "notExercised": ["camera capture", "Google account authorization/sync", "native map dragging"],
        }, ensure_ascii=False, indent=2) + "\n")
    return 1 if failure else 0


if __name__ == "__main__":
    sys.exit(main())
