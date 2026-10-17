#!/usr/bin/env python3
"""Black-box smoke for the distributed release APK; uses no debug bridge in WebView.

Usage: ANDROID_SERIAL=emulator-5554 scripts/check-android.sh
Requires adb and a booted dedicated emulator. The APK is installed without clearing
existing application data. Only a uniquely named synthetic diary entry is added.
Screenshots, accessibility trees and diagnostics go to artifacts/android/.
Every subprocess and every polling/scrolling loop has a deadline of at most 60s.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "ru.usbashka.mob"
ACTIVITY = PACKAGE + "/.MainActivity"


def bounds(node):
    values = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not values:
        return None
    left, top, right, bottom = map(int, values.groups())
    return (left, top, right, bottom) if right > left and bottom > top else None


def find_node(tree, text, editable=False, exact=False):
    matches = []
    for node in tree.iter("node"):
        if node.get("enabled") == "false" or bounds(node) is None:
            continue
        if editable and not node.get("class", "").endswith("EditText"):
            continue
        values = [node.get(key, "") for key in ("text", "content-desc", "resource-id", "hint")]
        if any(text == value if exact else text in value for value in values):
            score = (any(text == value for value in values), node.get("clickable") == "true")
            matches.append((score, node))
    return max(matches, key=lambda pair: pair[0])[1] if matches else None


def find_labeled_input(tree, identifier, label):
    """Resolve a unique input even when WebView omits its HTML label relation."""
    inputs = [node for node in tree.iter("node")
              if node.get("class", "").endswith("EditText")
              and node.get("enabled") != "false" and bounds(node) is not None]
    named = []
    for node in inputs:
        values = [node.get(key, "") for key in ("text", "content-desc", "resource-id", "hint")]
        if any(value in (identifier, label) for value in values) or node.get("resource-id", "").endswith("/" + identifier):
            named.append(node)
    if len(named) > 1:
        raise RuntimeError(f"Ambiguous input {identifier!r}: {len(named)} controls have its name")
    if named:
        return named[0]

    # UIAutomator can expose a screen-reader-only HTML label as a tiny sibling
    # while leaving its EditText name, hint and resource-id empty. Its live
    # position still identifies the containing control without assuming order.
    associated = set()
    for node in tree.iter("node"):
        rectangle = bounds(node)
        if (node in inputs or node.get("enabled") == "false" or rectangle is None
                or label not in (node.get("text", ""), node.get("content-desc", ""))):
            continue
        left, top, right, bottom = rectangle
        x, y = (left + right) / 2, (top + bottom) / 2
        for candidate in inputs:
            if candidate.get("package") != node.get("package"):
                continue
            left, top, right, bottom = bounds(candidate)
            if left <= x < right and top <= y < bottom:
                associated.add(candidate)
    if len(associated) > 1:
        raise RuntimeError(f"Ambiguous input {identifier!r}: label {label!r} overlaps {len(associated)} controls")
    return next(iter(associated)) if associated else None


class Smoke:
    def __init__(self, args):
        self.args = args
        self.serial = args.serial
        self.artifacts = args.artifacts.resolve()
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.tree = None
        self.checks = []
        self.title = "MOB-Android-smoke-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")

    def adb(self, *arguments, timeout=20, check=True, binary=False):
        command = [self.args.adb]
        if self.serial:
            command += ["-s", self.serial]
        command += list(arguments)
        result = subprocess.run(command, capture_output=True, timeout=max(0.1, min(60, timeout)))
        if check and result.returncode:
            raise RuntimeError(f"adb {' '.join(arguments)} failed: {result.stderr.decode(errors='replace')} {result.stdout.decode(errors='replace')}")
        return result.stdout if binary else result.stdout.decode("utf-8", errors="replace").strip()

    def verified(self, message):
        self.checks.append(message)
        print("VERIFIED: " + message, flush=True)

    def select_emulator(self):
        if not shutil.which(self.args.adb):
            raise RuntimeError("adb is not on PATH; set ADB to its executable path")
        devices = self.adb("devices", timeout=10)
        online = [line.split()[0] for line in devices.splitlines() if re.match(r"^emulator-\d+\s+device(?:\s|$)", line)]
        if self.serial:
            if not re.fullmatch(r"emulator-\d+", self.serial) or self.serial not in online:
                raise RuntimeError("ANDROID_SERIAL must select an online emulator-* device; physical devices are never modified")
        elif len(online) == 1:
            self.serial = online[0]
        else:
            raise RuntimeError("Set ANDROID_SERIAL to exactly one online emulator-* device")
        if self.adb("shell", "getprop", "ro.kernel.qemu") != "1":
            raise RuntimeError("The selected device is not an Android emulator")
        print(f"Testing {self.args.apk.resolve()} on {self.serial}", flush=True)

    def dump(self, timeout=15):
        deadline = time.monotonic() + timeout
        remote = "/sdcard/mob-smoke-window.xml"
        self.adb("shell", "rm", "-f", remote, timeout=min(5, timeout))
        self.adb("shell", "uiautomator", "dump", "--compressed", remote, timeout=deadline - time.monotonic())
        xml = self.adb("exec-out", "cat", remote, timeout=deadline - time.monotonic(), binary=True)
        self.tree = ET.fromstring(xml)
        (self.artifacts / "latest.xml").write_bytes(xml)
        return self.tree

    def screenshot(self, name):
        # WebView's accessibility tree can update before the compositor paints
        # the corresponding frame, especially immediately after launch.
        time.sleep(.8)
        image = self.adb("exec-out", "screencap", "-p", timeout=15, binary=True)
        if not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("Android did not return a PNG screenshot")
        (self.artifacts / (name + ".png")).write_bytes(image)
        if self.tree is not None:
            ET.ElementTree(self.tree).write(self.artifacts / (name + ".xml"), encoding="utf-8", xml_declaration=True)

    def wait_text(self, text, editable=False, seconds=60, exact=False):
        deadline = time.monotonic() + min(60, seconds)
        last_error = "not present in the visible accessibility tree"
        while time.monotonic() < deadline:
            try:
                tree = self.dump(timeout=min(15, deadline - time.monotonic()))
                node = find_node(tree, text, editable, exact=exact)
                if node is not None:
                    return node
            except (RuntimeError, subprocess.TimeoutExpired, ET.ParseError) as error:
                last_error = str(error)
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError(f"Visible UI did not contain {text!r} within {seconds}s: {last_error}")

    def wait_labeled_input(self, identifier, label, seconds=30):
        deadline = time.monotonic() + min(60, seconds)
        last_error = "no uniquely associated input in the visible accessibility tree"
        tree = self.tree
        while time.monotonic() < deadline:
            if tree is not None:
                # Ambiguity is an immediate failure, not a reason to tap an
                # arbitrary control or keep polling until another one vanishes.
                node = find_labeled_input(tree, identifier, label)
                if node is not None:
                    return node
            try:
                tree = self.dump(timeout=min(15, deadline - time.monotonic()))
            except (RuntimeError, subprocess.TimeoutExpired, ET.ParseError) as error:
                last_error = str(error)
                tree = None
            if tree is None:
                time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError(f"Visible UI did not contain input {identifier!r} ({label}) within {seconds}s: {last_error}")

    def tap(self, node):
        left, top, right, bottom = bounds(node)
        self.adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))

    def swipe(self, downward=False):
        # Coordinates come from the live WebView bounds, never a fixed device size.
        nodes = [node for node in self.tree.iter("node") if node.get("class") == "android.webkit.WebView" and bounds(node)]
        if not nodes:
            raise RuntimeError("A visible Android WebView was not found")
        left, top, right, bottom = bounds(nodes[0])
        x = (left + right) // 2
        high, low = int(top + (bottom - top) * .28), int(top + (bottom - top) * .79)
        start, end = (high, low) if downward else (low, high)
        self.adb("shell", "input", "swipe", str(x), str(start), str(x), str(end), "350", timeout=5)

    def seek_text(self, text, downward=False):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.dump(timeout=min(15, deadline - time.monotonic()))
            node = find_node(self.tree, text)
            if node is not None:
                return node
            if deadline - time.monotonic() < 6:
                break
            self.swipe(downward=downward)
            time.sleep(min(.4, max(0, deadline - time.monotonic())))
        raise RuntimeError(f"Could not scroll to visible UI element {text!r}")

    def launch(self):
        self.adb("shell", "am", "force-stop", PACKAGE)
        self.adb("shell", "am", "start", "-W", "-n", ACTIVITY, timeout=60)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = self.adb("shell", "dumpsys", "activity", "activities", timeout=min(10, deadline - time.monotonic()))
            (self.artifacts / "activity.txt").write_text(status)
            if any(PACKAGE in line and "MainActivity" in line and re.search(r"(?:mResumedActivity|topResumedActivity)", line) for line in status.splitlines()):
                return
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise RuntimeError("MainActivity did not become the resumed activity within 60s")

    def run(self):
        if not self.args.apk.is_file():
            raise RuntimeError(f"Distributed release APK does not exist: {self.args.apk}")
        self.select_emulator()
        install = self.adb("install", "-r", str(self.args.apk.resolve()), timeout=60)
        if "Success" not in install:
            raise RuntimeError("Android package installer did not report Success: " + install)
        package_info = self.adb("shell", "dumpsys", "package", PACKAGE)
        (self.artifacts / "package.txt").write_text(package_info)
        if re.search(r"(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b", package_info):
            raise RuntimeError("Installed APK is debuggable; this test must exercise the distributed release")
        self.verified("The distributed non-debuggable APK installs successfully")

        self.launch()
        self.wait_text("Между сном и явью")
        if not any(node.get("class") == "android.webkit.WebView" for node in self.tree.iter("node")):
            raise RuntimeError("The diary heading did not come from a visible WebView")
        self.screenshot("01-diary")
        self.verified("MainActivity resumes and its WebView renders the Russian diary heading")

        self.tap(self.wait_text("Новая запись"))
        self.wait_text("Что хочется сохранить?")
        title_input = self.wait_labeled_input("entry-title", "Название")
        self.tap(title_input)
        self.adb("shell", "input", "text", self.title)
        self.wait_text(self.title, editable=True)
        keyboard = self.adb("shell", "dumpsys", "input_method")
        if re.search(r"(?:mInputShown|mIsInputViewShown|isInputViewShown)=true", keyboard):
            self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
        self.screenshot("02-editor")
        self.tap(self.seek_text("Сохранить запись"))
        self.wait_text("Между сном и явью")
        self.seek_text(self.title)
        self.screenshot("03-saved-entry")
        self.verified("A synthetic diary entry is created and saved through native accessibility/touch input")

        self.launch()
        self.wait_text("Между сном и явью")
        self.tap(self.seek_text(self.title))
        self.wait_text("Редактировать", exact=True)
        self.wait_text(self.title)
        self.screenshot("04-persisted-entry")
        self.verified("The saved entry survives force-stop/relaunch and opens in the entry reader")

        # Relaunch closes the reader; bottom navigation remains reachable after scrolling.
        self.launch()
        self.wait_text("Между сном и явью")
        self.tap(self.wait_text("Карта"))
        self.wait_text("У всего есть свои связи")
        self.wait_text("Приблизить карту")
        text = " ".join(node.get("text", "") + " " + node.get("content-desc", "") for node in self.tree.iter("node"))
        if "Карта не загрузилась" in text:
            raise RuntimeError("The map displayed a load error")
        self.screenshot("05-map")
        self.verified("Map navigation renders its Russian heading and accessible zoom control")
        print("NOT EXERCISED: camera capture, Google account authorization/sync, and native map dragging.", flush=True)

    def diagnostics(self):
        if not self.serial:
            return
        for name, command in (("logcat.txt", ("logcat", "-d", "-t", "1000")), ("window.txt", ("shell", "dumpsys", "window"))):
            try:
                (self.artifacts / name).write_text(self.adb(*command, timeout=10, check=False))
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            self.dump(timeout=10)
            self.screenshot("final")
        except (RuntimeError, OSError, subprocess.TimeoutExpired, ET.ParseError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, default=Path(os.environ.get("APK", ROOT / "distributions/MOB-1.0.1.apk")))
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts/android")
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"))
    parser.add_argument("--adb", default=os.environ.get("ADB", "adb"))
    smoke = Smoke(parser.parse_args())
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
            "syntheticEntry": smoke.title,
            "notExercised": ["camera capture", "Google account authorization/sync", "native map dragging"],
        }, ensure_ascii=False, indent=2) + "\n")
    return 1 if failure else 0


if __name__ == "__main__":
    sys.exit(main())
