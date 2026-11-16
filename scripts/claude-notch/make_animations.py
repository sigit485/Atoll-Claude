#!/usr/bin/env python3
"""Writes the Lottie files used by claude-notch-daemon.mjs (claude-<state>.json).

Coordinates follow the 447x447 pixel mascot. Atoll draws the leading icon in a square
about as tall as the notch, so the mascot is scaled down to leave room for motion and props.
"""
import json
from pathlib import Path

ORANGE = [0.871, 0.478, 0.341, 1]
RED = [0.898, 0.282, 0.302, 1]
BLACK = [0, 0, 0, 1]
WHITE = [1, 1, 1, 1]
GRAY = [0.62, 0.64, 0.68, 1]
DARK = [0.13, 0.13, 0.15, 1]
GREEN = [0.33, 0.9, 0.45, 1]
BLUE = [0.27, 0.55, 0.95, 1]
SIZE = 447
MASCOT_SCALE = 70
FPS = 30


def static(value):
    return {"a": 0, "k": value}


def animated(points):
    dims = len(points[0][1]) if isinstance(points[0][1], list) else 1
    ease_out = {"x": [0.4] * dims, "y": [0] * dims}
    ease_in = {"x": [0.6] * dims, "y": [1] * dims}
    frames = [{"t": t, "s": v if isinstance(v, list) else [v], "o": ease_out, "i": ease_in} for t, v in points[:-1]]
    last = points[-1][1]
    frames.append({"t": points[-1][0], "s": last if isinstance(last, list) else [last]})
    return {"a": 1, "k": frames}


def box(x1, x2, y1, y2):
    return [(x1 + x2) / 2, (y1 + y2) / 2], [x2 - x1, y2 - y1]


def rect(name, x1, x2, y1, y2):
    position, size = box(x1, x2, y1, y2)
    return {"ty": "rc", "nm": name, "d": 1, "p": static(position), "s": static(size), "r": static(0)}


def moving_rect(name, frames):
    """frames: [(t, (x1, x2, y1, y2)), ...]"""
    return {
        "ty": "rc", "nm": name, "d": 1, "r": static(0),
        "p": animated([(t, box(*b)[0]) for t, b in frames]),
        "s": animated([(t, box(*b)[1]) for t, b in frames]),
    }


def ellipse(name, center, size):
    return {"ty": "el", "nm": name, "d": 1, "p": static(list(center)),
            "s": animated(size) if isinstance(size[0], tuple) else static(list(size))}


def fill(color, opacity=100):
    return {"ty": "fl", "nm": "fill", "c": static(color), "o": static(opacity), "r": 1}


def stroke(color, width):
    return {"ty": "st", "nm": "stroke", "c": static(color), "o": static(100), "w": static(width),
            "lc": 2, "lj": 2, "ml": 4}


def transform(position=None, scale=None, anchor=(0, 0), rotation=0, opacity=None):
    return {
        "ty": "tr", "p": position or static(list(anchor)), "a": static(list(anchor)),
        "s": scale or static([100, 100]), "r": static(rotation), "o": opacity or static(100),
        "sk": static(0), "sa": static(0),
    }


def group(name, items):
    return {"ty": "gr", "nm": name, "it": items}


BLINK = [(0, [100, 100]), (49, [100, 100]), (52, [100, 10]), (55, [100, 100]), (60, [100, 100])]
STILL_ARMS = [rect("arms", 0, 447, 205, 260)]


def body(color=ORANGE, blink=None, bob=None, arms=STILL_ARMS):
    eyes = group("eyes", [
        rect("eye-left", 112, 139, 150, 203), rect("eye-right", 307, 334, 150, 203),
        fill(BLACK), transform(scale=animated(blink) if blink else None, anchor=(223, 176)),
    ])
    torso = group("torso", arms + [rect("torso", 56, 390, 93, 318), fill(color), transform()])
    return group("body", [eyes, torso, transform(position=animated(bob) if bob else None)])


def legs(name, xs, lift=None, color=ORANGE):
    shapes = [rect(f"{name}-{x}", x, x + 27, 290, 372) for x in xs]
    return group(name, shapes + [fill(color), transform(position=animated(lift) if lift else None)])


def standing_legs(color=ORANGE):
    return legs("legs", (84, 139, 279, 334), color=color)


def lottie(name, frames, shapes, offset=None):
    # lottie-ios ignores animated layer positions, so whole-body motion is a group transform.
    mover = group("mover", shapes + [transform(position=animated(offset) if offset else None)])
    return {
        "v": "5.7.4", "fr": FPS, "ip": 0, "op": frames, "w": SIZE, "h": SIZE, "nm": name,
        "ddd": 0, "assets": [],
        "layers": [{
            "ddd": 0, "ind": 1, "ty": 4, "nm": "mascot", "sr": 1,
            "ks": {
                "o": static(100), "r": static(0), "p": static([223.5, 232, 0]),
                "a": static([223.5, 232, 0]), "s": static([MASCOT_SCALE, MASCOT_SCALE, 100]),
            },
            "ao": 0, "ip": 0, "op": frames, "st": 0, "bm": 0,
            "shapes": [mover],
        }],
    }


def working():
    # Walks right, back left, then back to the middle; one leg pair steps per 15 frames.
    up, down = [0, -16], [0, 0]
    bob = [(0, [0, 0]), (8, [0, -12]), (15, [0, 0]), (23, [0, -12]), (30, [0, 0]),
           (38, [0, -12]), (45, [0, 0]), (53, [0, -12]), (60, [0, 0])]
    legs_a = legs("legs-a", (84, 279), [(0, down), (7, up), (15, down), (30, down), (37, up), (45, down), (60, down)])
    legs_b = legs("legs-b", (139, 334), [(0, down), (15, down), (22, up), (30, down), (45, down), (52, up), (60, down)])
    travel = 95
    walk = [(0, [0, 0]), (15, [travel, 0]), (45, [-travel, 0]), (60, [0, 0])]
    return lottie("claude-working", 60, [body(blink=BLINK, bob=bob), legs_a, legs_b], walk)


def done():
    # Arms raised and waving while the mascot hops.
    def arm(name, x1, x2):
        return moving_rect(name, [(0, (x1, x2, 20, 260)), (15, (x1, x2, 50, 260)), (30, (x1, x2, 20, 260))])

    hop = [(0, [0, 0]), (8, [0, -50]), (15, [0, 0]), (30, [0, 0])]
    return lottie("claude-done", 30, [body(arms=[arm("arm-left", 0, 56), arm("arm-right", 391, 447)]),
                                      standing_legs()], hop)


def typing():
    # Hands take turns hitting a keyboard in front of the mascot.
    def hand(name, x1, x2, presses):
        rest, pressed = (x1, x2, 205, 260), (x1, x2, 205, 345)
        frames = [(0, rest)]
        for start in presses:
            frames += [(start, rest), (start + 3, pressed), (start + 6, rest)]
        frames.append((30, rest))
        return moving_rect(name, frames)

    arms = [hand("hand-left", 0, 56, (0, 15)), hand("hand-right", 391, 447, (8, 22))]
    keys = [rect(f"key-{x}", x, x + 40, 352, 372) for x in range(60, 400, 58)]
    keyboard = group("keyboard", [
        group("keys", keys + [fill(DARK), transform()]),
        group("board", [rect("board", 30, 417, 335, 400), fill(GRAY), transform()]),
        transform(),
    ])
    return lottie("claude-typing", 30, [body(arms=arms), keyboard, standing_legs()])


def reading():
    # A magnifying glass sweeps across the mascot's face.
    handle = group("handle", [rect("handle", -13, 13, 0, 90), fill(GRAY), transform(position=static([48, 48]),
                                                                                         rotation=-45)])
    lens = group("lens", [ellipse("lens", (0, 0), (150, 150)), stroke(GRAY, 24), fill(WHITE, 25), transform()])
    sweep = animated([(0, [100, 176]), (30, [346, 176]), (60, [100, 176])])
    magnifier = group("magnifier", [handle, lens, transform(position=sweep)])
    return lottie("claude-reading", 60, [magnifier, body(blink=BLINK), standing_legs()])


def bash():
    # A tiny terminal with a blinking cursor sits in front of the mascot.
    prompt = group("prompt", [rect("p1", 140, 165, 320, 345), rect("p2", 165, 190, 345, 370),
                              rect("p3", 140, 165, 370, 395), fill(GREEN), transform()])
    blink = animated([(0, 100), (12, 100), (15, 0), (27, 0), (30, 100)])
    cursor = group("cursor", [rect("cursor", 205, 260, 380, 395), fill(GREEN), transform(opacity=blink)])
    screen = group("screen", [rect("screen", 110, 337, 295, 425), stroke(GRAY, 12), fill(DARK), transform()])
    bob = [(0, [0, 0]), (15, [0, -8]), (30, [0, 0])]
    return lottie("claude-bash", 30, [prompt, cursor, screen, body(bob=bob), standing_legs()])


def web():
    # A spinning globe in front of the mascot.
    meridian = group("meridian", [ellipse("meridian", (0, 0), ((0, [200, 200]), (30, [20, 200]), (60, [200, 200]))),
                                  stroke(WHITE, 10), transform()])
    equator = group("equator", [rect("equator", -100, 100, -5, 5), fill(WHITE), transform()])
    ball = group("ball", [ellipse("ball", (0, 0), (200, 200)), fill(BLUE), transform()])
    globe = group("globe", [meridian, equator, ball, transform(position=static([223.5, 360]))])
    return lottie("claude-web", 60, [globe, body(blink=BLINK), standing_legs()])


def attention():
    # Red mascot waving both arms over an exclamation mark, shaking side to side.
    def arm(name, x1, x2, high_first):
        high, low = (x1, x2, 10, 260), (x1, x2, 130, 260)
        a, b = (high, low) if high_first else (low, high)
        return moving_rect(name, [(0, a), (5, b), (10, a), (15, b), (20, a)])

    mark = group("mark", [rect("bar", 205, 242, -85, -5), rect("dot", 205, 242, 12, 42), fill(WHITE), transform()])
    shake = [(0, [0, 0]), (3, [-18, 0]), (8, [18, 0]), (13, [-18, 0]), (18, [18, 0]), (20, [0, 0])]
    arms = [arm("arm-left", 0, 56, True), arm("arm-right", 391, 447, False)]
    return lottie("claude-attention", 20, [mark, body(color=RED, arms=arms), standing_legs(RED)], shake)


if __name__ == "__main__":
    here = Path(__file__).parent
    for build in (working, done, typing, reading, bash, web, attention):
        animation = build()
        (here / f"{animation['nm']}.json").write_text(json.dumps(animation, separators=(",", ":")))
