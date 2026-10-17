//! The dream atlas is a real Rusterize Application. Rust owns its scene,
//! hit-testing, camera, interaction and animation; the host supplies local data.
use rusterize::*;
use std::{cell::RefCell, collections::VecDeque};

const BG: Color = Color::hex(0x11151e);
const INK: Color = Color::hex(0xf2f2fa);
const MUTED: Color = Color::hex(0x9296ac);
const TEAL: Color = Color::hex(0x83d9c3);
const MAX_NODES: usize = 500;
const CHARACTER_OFFSET: usize = 10000;

#[derive(Clone)]
struct Node {
    name: String,
    position: Point,
    count: u32,
    lucid: u32,
    image: Option<Image>,
}
struct Edge {
    source: usize,
    target: usize,
    count: u32,
}
struct Character {
    name: String,
    homes: Vec<usize>,
    image: Option<Image>,
}
#[derive(Clone, Copy)]
struct Interaction {
    id: u64,
    node: Option<usize>,
    down: Point,
    origin: Point,
    moved: bool,
}
#[derive(Clone, Copy, Default)]
struct Output {
    kind: u32,
    node: usize,
    x: f32,
    y: f32,
}
struct Atlas {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    characters: Vec<Character>,
    buffer: Vec<u8>,
    zoom: f32,
    pan: Point,
    viewport: Viewport,
    pointer: Option<Interaction>,
    selected: Option<usize>,
    hover: Option<usize>,
    reduced_motion: bool,
    time: f32,
    out: VecDeque<Output>,
    last: Output,
}
impl Default for Atlas {
    fn default() -> Self {
        Self {
            nodes: vec![],
            edges: vec![],
            characters: vec![],
            buffer: vec![],
            zoom: 1.0,
            pan: Point::default(),
            viewport: Viewport::new(1000.0, 700.0, 1.0),
            pointer: None,
            selected: None,
            hover: None,
            reduced_motion: false,
            time: 0.0,
            out: VecDeque::new(),
            last: Output::default(),
        }
    }
}
thread_local! { static ATLAS: RefCell<Atlas> = RefCell::new(Atlas::default()); }

fn default_position(index: usize, total: usize) -> Point {
    if total <= 1 {
        return Point::new(500.0, 350.0);
    }
    let angle = index as f32 * 2.3999631 - 1.1;
    let radius = (index as f32 + 1.0).sqrt() / (total as f32).sqrt();
    Point::new(
        500.0 + angle.cos() * radius * 350.0,
        350.0 + angle.sin() * radius * 230.0,
    )
}
impl Atlas {
    fn scale(&self) -> f32 {
        (self.viewport.size.width / 1000.0)
            .min(self.viewport.size.height / 700.0)
            .max(0.05)
            * self.zoom
    }
    fn world(&self, p: Point) -> Point {
        let s = self.scale();
        Point::new(
            (p.x - self.viewport.size.width * 0.5 - self.pan.x) / s + 500.0,
            (p.y - self.viewport.size.height * 0.5 - self.pan.y) / s + 350.0,
        )
    }
    fn screen(&self, p: Point) -> Point {
        let s = self.scale();
        Point::new(
            (p.x - 500.0) * s + self.viewport.size.width * 0.5 + self.pan.x,
            (p.y - 350.0) * s + self.viewport.size.height * 0.5 + self.pan.y,
        )
    }
    fn zoom_at(&mut self, factor: f32, anchor: Point) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let before = self.world(anchor);
        self.zoom = (self.zoom * factor).clamp(0.35, 4.5);
        let after = self.screen(before);
        self.pan.x += anchor.x - after.x;
        self.pan.y += anchor.y - after.y;
    }
    fn center(&self) -> Point {
        Point::new(
            self.viewport.size.width * 0.5,
            self.viewport.size.height * 0.5,
        )
    }
    fn reset(&mut self) {
        self.zoom = 1.0;
        self.pan = Point::default();
        if self.nodes.is_empty() {
            return;
        }
        let min_x = self
            .nodes
            .iter()
            .map(|n| n.position.x)
            .fold(f32::INFINITY, f32::min)
            - 105.0;
        let max_x = self
            .nodes
            .iter()
            .map(|n| n.position.x)
            .fold(f32::NEG_INFINITY, f32::max)
            + 105.0;
        let min_y = self
            .nodes
            .iter()
            .map(|n| n.position.y)
            .fold(f32::INFINITY, f32::min)
            - 105.0;
        let max_y = self
            .nodes
            .iter()
            .map(|n| n.position.y)
            .fold(f32::NEG_INFINITY, f32::max)
            + 105.0;
        self.zoom = (1000.0 / (max_x - min_x))
            .min(700.0 / (max_y - min_y))
            .clamp(0.35, 1.4);
        self.pan = Point::new(
            (500.0 - (min_x + max_x) * 0.5) * self.scale(),
            (350.0 - (min_y + max_y) * 0.5) * self.scale(),
        );
    }
    fn character_position(&self, index: usize) -> Option<Point> {
        let character = self.characters.get(index)?;
        if character.homes.is_empty() {
            return None;
        }
        let time = if self.reduced_motion { 0.0 } else { self.time };
        // Each visitor walks between the places where it actually appeared.
        let route = time * 0.045 + index as f32 * 0.73;
        let step = route.floor() as usize;
        let a = self
            .nodes
            .get(character.homes[step % character.homes.len()])?
            .position;
        let b = self
            .nodes
            .get(character.homes[(step + 1) % character.homes.len()])?
            .position;
        let progress = (route.fract() - 0.25).clamp(0.0, 0.75) / 0.75;
        let progress = progress * progress * (3.0 - 2.0 * progress);
        let phase = time * 0.35 + index as f32 * 2.1;
        let visual_scale = (0.85 / self.scale()).max(1.0);
        Some(Point::new(
            a.x + (b.x - a.x) * progress + phase.cos() * 72.0 * visual_scale,
            a.y + (b.y - a.y) * progress + (48.0 + phase.sin() * 16.0) * visual_scale,
        ))
    }
    fn hit(&self, position: Point) -> Option<usize> {
        let p = self.world(position);
        let visual_scale = (0.85 / self.scale()).max(1.0);
        for i in (0..self.characters.len()).rev() {
            if let Some(c) = self.character_position(i) {
                if (p.x - c.x).hypot(p.y - c.y) < 23.0 * visual_scale {
                    return Some(CHARACTER_OFFSET + i);
                }
            }
        }
        self.nodes.iter().rposition(|n| {
            Rect::new(
                n.position.x - 66.0 * visual_scale,
                n.position.y - 61.0 * visual_scale,
                132.0 * visual_scale,
                110.0 * visual_scale,
            )
            .contains(p)
        })
    }
    fn emit(&mut self, event: Output) {
        if self.out.len() == 64 {
            self.out.pop_front();
        }
        self.out.push_back(event);
    }
    fn cancel(&mut self) {
        if let Some(drag) = self.pointer.take() {
            if let Some(node) = drag.node.and_then(|i| self.nodes.get_mut(i)) {
                node.position = drag.origin;
            }
        }
    }
    fn focus(&mut self, index: usize) {
        if let Some(node) = self.nodes.get(index) {
            let position = node.position;
            self.selected = Some(index);
            self.zoom = self.zoom.max(1.3);
            self.pan = Point::new(
                (500.0 - position.x) * self.scale(),
                (350.0 - position.y) * self.scale(),
            );
        }
    }
}

// A single bounded scratch buffer avoids JSON parsing and external dependencies.
// The browser obtains the pointer, copies bytes, then commits text or RGBA data.
#[no_mangle]
pub extern "C" fn app_buffer(length: usize) -> *mut u8 {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        a.buffer.resize(length.min(256 * 256 * 4), 0);
        a.buffer.as_mut_ptr()
    })
}
#[no_mangle]
pub extern "C" fn app_begin() {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        a.cancel();
        a.nodes.clear();
        a.edges.clear();
        a.characters.clear();
        a.selected = None;
        a.hover = None;
        a.out.clear();
    });
}
#[no_mangle]
pub extern "C" fn app_node(
    x: f32,
    y: f32,
    count: u32,
    lucid: u32,
    index: usize,
    total: usize,
    positioned: u32,
) {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        if a.nodes.len() >= MAX_NODES || !x.is_finite() || !y.is_finite() {
            return;
        }
        a.nodes.push(Node {
            name: String::new(),
            position: if positioned != 0 {
                Point::new(x.clamp(-10000.0, 10000.0), y.clamp(-10000.0, 10000.0))
            } else {
                default_position(index, total)
            },
            count,
            lucid,
            image: None,
        });
    });
}
#[no_mangle]
pub extern "C" fn app_edge(source: usize, target: usize, count: u32) {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        if source < a.nodes.len()
            && target < a.nodes.len()
            && source != target
            && a.edges.len() < 2500
        {
            a.edges.push(Edge {
                source,
                target,
                count,
            });
        }
    });
}
#[no_mangle]
pub extern "C" fn app_character() {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        if a.characters.len() < 200 {
            a.characters.push(Character {
                name: String::new(),
                homes: vec![],
                image: None,
            });
        }
    });
}
#[no_mangle]
pub extern "C" fn app_character_home(character: usize, node: usize) {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        if node < a.nodes.len() {
            if let Some(c) = a.characters.get_mut(character) {
                if !c.homes.contains(&node) {
                    c.homes.push(node);
                }
            }
        }
    });
}
#[no_mangle]
pub extern "C" fn app_name(index: usize) {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        let name = String::from_utf8_lossy(&a.buffer)
            .chars()
            .take(100)
            .collect::<String>();
        if index >= CHARACTER_OFFSET {
            if let Some(c) = a.characters.get_mut(index - CHARACTER_OFFSET) {
                c.name = name;
            }
        } else if let Some(n) = a.nodes.get_mut(index) {
            n.name = name;
        }
    });
}
#[no_mangle]
pub extern "C" fn app_image(index: usize, width: u32, height: u32) -> u32 {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        if width > 256 || height > 256 {
            return 0;
        }
        let Ok(image) = Image::rgba(width, height, a.buffer.clone()) else {
            return 0;
        };
        if index >= CHARACTER_OFFSET {
            if let Some(c) = a.characters.get_mut(index - CHARACTER_OFFSET) {
                c.image = Some(image);
            }
        } else if let Some(n) = a.nodes.get_mut(index) {
            n.image = Some(image);
        }
        1
    })
}
#[no_mangle]
pub extern "C" fn app_config(reduced_motion: u32) {
    ATLAS.with(|a| a.borrow_mut().reduced_motion = reduced_motion != 0);
}
#[no_mangle]
pub extern "C" fn app_zoom(factor: f32) {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        let center = a.center();
        a.zoom_at(factor, center);
    });
}
#[no_mangle]
pub extern "C" fn app_reset() {
    ATLAS.with(|a| a.borrow_mut().reset());
}
#[no_mangle]
pub extern "C" fn app_focus(index: usize) {
    ATLAS.with(|a| a.borrow_mut().focus(index));
}
#[no_mangle]
pub extern "C" fn app_event_next() -> u32 {
    ATLAS.with(|a| {
        let mut a = a.borrow_mut();
        a.last = a.out.pop_front().unwrap_or_default();
        a.last.kind
    })
}
#[no_mangle]
pub extern "C" fn app_event_value(component: u32) -> f32 {
    ATLAS.with(|a| {
        let a = a.borrow();
        match component {
            0 => a.last.node as f32,
            1 => a.last.x,
            2 => a.last.y,
            _ => 0.0,
        }
    })
}
#[no_mangle]
pub extern "C" fn app_node_value(index: usize, component: u32) -> f32 {
    ATLAS.with(|a| {
        let a = a.borrow();
        a.nodes
            .get(index)
            .map(|n| match component {
                0 => n.position.x,
                1 => n.position.y,
                2 => a.screen(n.position).x,
                3 => a.screen(n.position).y,
                _ => 0.0,
            })
            .unwrap_or(0.0)
    })
}

#[derive(Default)]
pub struct App;
impl Application for App {
    fn window_options(&self) -> WindowOptions {
        WindowOptions {
            title: "MOB · Атлас сновидений".into(),
            title_bar: TitleBarStyle::dark(),
            ..WindowOptions::default()
        }
    }
    fn event(&mut self, event: Event, ctx: &mut Context) {
        ATLAS.with(|a| {
            let mut a = a.borrow_mut();
            match event {
                Event::Resize(v) => a.viewport = v,
                Event::Frame { elapsed, .. } => a.time = elapsed as f32,
                Event::Suspend | Event::Focus(false) => a.cancel(),
                Event::Pointer {
                    id,
                    phase: PointerPhase::Down,
                    position,
                    ..
                } => {
                    if a.pointer.is_none() {
                        let node = a.hit(position);
                        let origin = node
                            .and_then(|i| a.nodes.get(i))
                            .map(|n| n.position)
                            .unwrap_or(a.pan);
                        a.selected = node;
                        a.pointer = Some(Interaction {
                            id,
                            node,
                            down: position,
                            origin,
                            moved: false,
                        });
                    }
                }
                Event::Pointer {
                    id,
                    phase: PointerPhase::Move,
                    position,
                    ..
                } => {
                    a.hover = a.hit(position);
                    if let Some(mut drag) = a.pointer.filter(|d| d.id == id) {
                        let dx = position.x - drag.down.x;
                        let dy = position.y - drag.down.y;
                        drag.moved |= dx.hypot(dy) > 5.0;
                        if drag.moved {
                            let scale = a.scale();
                            if let Some(node) = drag.node.and_then(|i| a.nodes.get_mut(i)) {
                                node.position = Point::new(
                                    (drag.origin.x + dx / scale).clamp(-10000.0, 10000.0),
                                    (drag.origin.y + dy / scale).clamp(-10000.0, 10000.0),
                                );
                            } else if drag.node.is_none() {
                                a.pan = Point::new(drag.origin.x + dx, drag.origin.y + dy);
                            }
                        }
                        a.pointer = Some(drag);
                    }
                }
                Event::Pointer {
                    id,
                    phase: PointerPhase::Up,
                    position,
                    ..
                } => {
                    if let Some(drag) = a.pointer.filter(|d| d.id == id) {
                        a.pointer = None;
                        if let Some(index) = drag.node {
                            if drag.moved {
                                if let Some(node) = a.nodes.get(index) {
                                    let p = node.position;
                                    a.emit(Output {
                                        kind: 2,
                                        node: index,
                                        x: p.x,
                                        y: p.y,
                                    });
                                }
                            } else if a.hit(position) == Some(index) {
                                a.emit(Output {
                                    kind: 1,
                                    node: index,
                                    ..Output::default()
                                });
                            }
                        }
                    }
                }
                Event::Pointer {
                    id,
                    phase: PointerPhase::Cancel,
                    ..
                } => {
                    if a.pointer.is_some_and(|d| d.id == id) {
                        a.cancel();
                    }
                }
                Event::Scroll { position, delta } => a.zoom_at((-delta.y * 0.0015).exp(), position),
                Event::Key {
                    key,
                    pressed: true,
                    modifiers,
                    ..
                } => match key {
                    Key::Enter | Key::Space => {
                        if let Some(index) = a.selected {
                            a.emit(Output {
                                kind: 1,
                                node: index,
                                ..Output::default()
                            });
                        }
                    }
                    Key::Escape => a.cancel(),
                    Key::Home => a.reset(),
                    Key::Left => a.pan.x += 40.0,
                    Key::Right => a.pan.x -= 40.0,
                    Key::Up => a.pan.y += 40.0,
                    Key::Down => a.pan.y -= 40.0,
                    Key::Tab if !a.nodes.is_empty() => {
                        let next = if modifiers.shift {
                            a.selected.unwrap_or(0).wrapping_add(a.nodes.len() - 1) % a.nodes.len()
                        } else {
                            a.selected.map(|i| (i + 1) % a.nodes.len()).unwrap_or(0)
                        };
                        a.selected = Some(next);
                    }
                    _ => {}
                },
                Event::Text(text) => {
                    let factor = match text.as_str() {
                        "+" | "=" => 1.2,
                        "-" => 1.0 / 1.2,
                        _ => 1.0,
                    };
                    let center = a.center();
                    a.zoom_at(factor, center);
                }
                _ => {}
            }
            ctx.set_animation(
                !a.reduced_motion && a.characters.iter().any(|c| !c.homes.is_empty()),
            );
            ctx.request_redraw();
        });
    }
    fn draw(&mut self, c: &mut Canvas<'_>, v: Viewport) {
        ATLAS.with(|a| {
            let mut a = a.borrow_mut();
            a.viewport = v;
            c.clear(BG);
            let size = v.size;
            // Restrained star field remains in screen space while the atlas pans.
            for row in 0..(size.height / 32.0) as u32 + 1 {
                for col in 0..(size.width / 32.0) as u32 + 1 {
                    let hash = col.wrapping_mul(73856093) ^ row.wrapping_mul(19349663);
                    let alpha = if hash % 7 == 0 { 55 } else { 20 };
                    c.circle(
                        (col as f32 * 32.0 + 12.0, row as f32 * 32.0 + 12.0),
                        if hash % 7 == 0 { 1.0 } else { 0.65 },
                        Color::hex(0x858ba8).with_alpha(alpha),
                    );
                }
            }
            let scale = a.scale();
            c.with_save(|c| {
                c.translate(size.width * 0.5 + a.pan.x, size.height * 0.5 + a.pan.y);
                c.transform(Transform::scale(scale, scale));
                c.translate(-500.0, -350.0);
                for edge in &a.edges {
                    let from = a.nodes[edge.source].position;
                    let to = a.nodes[edge.target].position;
                    let mid = Point::new((from.x + to.x) * 0.5, (from.y + to.y) * 0.5);
                    let bend = ((to.x - from.x) * 0.14).clamp(-50.0, 50.0);
                    let path = Path::builder()
                        .move_to(from)
                        .cubic_to((mid.x, from.y + bend), (mid.x, to.y + bend), to)
                        .build();
                    let active = a.selected == Some(edge.source) || a.selected == Some(edge.target);
                    c.stroke(
                        path,
                        TEAL.with_alpha(if active { 145 } else { 52 }),
                        1.0 + (edge.count as f32).ln_1p().min(3.0),
                    );
                    c.circle((mid.x, mid.y + bend * 0.75), 3.0, TEAL.with_alpha(115));
                }
                for (i, node) in a.nodes.iter().enumerate() {
                    // Map markers retain legible size on narrow phone screens.
                    let visual_scale = (0.85 / scale).max(1.0);
                    c.with_save(|c| {
                        c.translate(node.position.x, node.position.y);
                        c.transform(Transform::scale(visual_scale, visual_scale));
                        c.translate(-node.position.x, -node.position.y);
                        draw_node(c, node, i, a.selected == Some(i) || a.hover == Some(i));
                    });
                }
                for (i, character) in a.characters.iter().enumerate() {
                    if let Some(p) = a.character_position(i) {
                        c.with_save(|c| {
                            let visual_scale = (0.85 / scale).max(1.0);
                            c.translate(p.x, p.y);
                            c.transform(Transform::scale(visual_scale, visual_scale));
                            c.translate(-p.x, -p.y);
                            c.ellipse(
                                Rect::new(p.x - 16.0, p.y + 17.0, 32.0, 9.0),
                                Color::BLACK.with_alpha(65),
                            );
                            c.circle(p, 20.0, Color::hex(0x28283c));
                            c.stroke(
                                Shape::Ellipse(Rect::new(p.x - 20.0, p.y - 20.0, 40.0, 40.0)),
                                Color::hex(0xb3a1f5),
                                1.5,
                            );
                            if let Some(image) = &character.image {
                                c.with_save(|c| {
                                    c.clip(Shape::Ellipse(Rect::new(
                                        p.x - 17.0,
                                        p.y - 17.0,
                                        34.0,
                                        34.0,
                                    )));
                                    c.image(
                                        image,
                                        Rect::new(p.x - 17.0, p.y - 17.0, 34.0, 34.0),
                                        1.0,
                                    );
                                });
                            } else {
                                centered(
                                    c,
                                    &character.name.chars().next().unwrap_or('·').to_string(),
                                    p.x,
                                    p.y + 5.0,
                                    15.0,
                                    Color::hex(0xd5c8ff),
                                    true,
                                );
                            }
                            if a.hover == Some(CHARACTER_OFFSET + i)
                                || a.selected == Some(CHARACTER_OFFSET + i)
                            {
                                centered(c, &character.name, p.x, p.y + 39.0, 12.0, INK, false);
                            }
                        });
                    }
                }
            });
        });
    }
}
fn centered(c: &mut Canvas<'_>, text: &str, x: f32, y: f32, size: f32, color: Color, bold: bool) {
    let style = TextStyle::new(size, color).family(FontFamily::Sans);
    let style = if bold { style.bold() } else { style };
    let width = c
        .measure_text(text, &style)
        .map(|m| m.width)
        .unwrap_or(text.chars().count() as f32 * size * 0.55);
    c.text(text, (x - width * 0.5, y), style);
}
fn draw_node(c: &mut Canvas<'_>, node: &Node, index: usize, active: bool) {
    let p = node.position;
    let accent = [
        TEAL,
        Color::hex(0xa79ce4),
        Color::hex(0x96b8e3),
        Color::hex(0xc3b896),
    ][index % 4];
    c.ellipse(
        Rect::new(p.x - 65.0, p.y + 28.0, 130.0, 25.0),
        Color::BLACK.with_alpha(60),
    );
    if active {
        c.circle((p.x, p.y - 8.0), 66.0, accent.with_alpha(15));
        c.stroke(
            Shape::Ellipse(Rect::new(p.x - 65.0, p.y - 73.0, 130.0, 130.0)),
            accent.with_alpha(85),
            1.0,
        );
    }
    let tile = Rect::new(p.x - 52.0, p.y - 60.0, 104.0, 86.0);
    c.rounded_rect(tile, 25.0, Color::hex(0x1e2c32));
    c.with_save(|c| {
        c.clip(Shape::RoundedRect(tile, 25.0));
        if let Some(image) = &node.image {
            c.image(image, tile, 1.0);
        } else {
            c.fill_rect(
                tile,
                Paint::Linear {
                    from: (tile.x, tile.y).into(),
                    to: (tile.x + 104.0, tile.y + 86.0).into(),
                    start: accent.with_alpha(40),
                    end: Color::hex(0x16232b),
                },
            );
            c.circle((p.x + 24.0, p.y - 35.0), 12.0, accent.with_alpha(100));
            match index % 3 {
                0 => {
                    for j in 0..4 {
                        let x = p.x - 39.0 + j as f32 * 26.0;
                        let y = p.y + 10.0 + (j % 2) as f32 * 8.0;
                        let tree = Path::builder()
                            .move_to((x, y - 43.0))
                            .line_to((x - 18.0, y))
                            .line_to((x + 18.0, y))
                            .close()
                            .build();
                        c.fill(tree, accent.with_alpha(90 + j as u8 * 20));
                        c.line((x, y), (x, y + 10.0), accent.with_alpha(150), 2.0);
                    }
                }
                1 => {
                    let mountains = Path::builder()
                        .move_to((p.x - 60.0, p.y + 29.0))
                        .line_to((p.x - 20.0, p.y - 36.0))
                        .line_to((p.x + 8.0, p.y + 5.0))
                        .line_to((p.x + 26.0, p.y - 20.0))
                        .line_to((p.x + 65.0, p.y + 29.0))
                        .close()
                        .build();
                    c.fill(mountains, accent.with_alpha(130));
                }
                _ => {
                    for j in 0..4 {
                        let x = p.x - 40.0 + j as f32 * 25.0;
                        let h = 27.0 + (j % 3) as f32 * 12.0;
                        c.rounded_rect(
                            Rect::new(x, p.y + 25.0 - h, 20.0, h),
                            3.0,
                            accent.with_alpha(110),
                        );
                        c.fill_rect(
                            Rect::new(x + 6.0, p.y + 31.0 - h, 4.0, 6.0),
                            Color::hex(0xe7d1a0).with_alpha(160),
                        );
                    }
                }
            }
            c.ellipse(
                Rect::new(p.x - 65.0, p.y + 17.0, 130.0, 20.0),
                Color::hex(0x102429).with_alpha(150),
            );
        }
    });
    c.stroke(
        Shape::RoundedRect(tile, 25.0),
        accent.with_alpha(if active { 220 } else { 65 }),
        if active { 2.0 } else { 1.0 },
    );
    let title = if node.name.chars().count() > 20 {
        format!("{}…", node.name.chars().take(19).collect::<String>())
    } else {
        node.name.clone()
    };
    centered(c, &title, p.x, p.y + 47.0, 14.0, INK, true);
    centered(
        c,
        &format!("{} {}", node.count, record_word(node.count)),
        p.x,
        p.y + 65.0,
        11.0,
        MUTED,
        false,
    );
    if node.lucid > 0 {
        let x = p.x + 45.0;
        let y = p.y - 52.0;
        let intensity = (node.lucid as f32).ln_1p() / 3.0;
        for ring in (1..=4).rev() {
            c.circle(
                (x, y),
                11.0 + ring as f32 * 5.0,
                Color::hex(0xffa955).with_alpha((7.0 + intensity * 12.0).min(32.0) as u8),
            );
        }
        let flame = Path::builder()
            .move_to((x, y - 24.0))
            .cubic_to(
                (x + 1.0, y - 9.0),
                (x + 15.0, y - 10.0),
                (x + 14.0, y + 3.0),
            )
            .cubic_to(
                (x + 14.0, y + 21.0),
                (x - 15.0, y + 21.0),
                (x - 15.0, y + 3.0),
            )
            .cubic_to(
                (x - 14.0, y - 4.0),
                (x - 10.0, y - 10.0),
                (x - 6.0, y - 12.0),
            )
            .line_to((x - 5.0, y - 3.0))
            .cubic_to((x, y - 8.0), (x - 1.0, y - 17.0), (x, y - 24.0))
            .close()
            .build();
        c.fill(
            flame,
            Paint::Linear {
                from: (x, y - 24.0).into(),
                to: (x, y + 20.0).into(),
                start: Color::hex(0xffd58c),
                end: Color::hex(0xf79e63),
            },
        );
        centered(
            c,
            &node.lucid.to_string(),
            x,
            y + 9.0,
            12.0,
            Color::hex(0x563320),
            true,
        );
    }
}
fn record_word(count: u32) -> &'static str {
    if (11..=14).contains(&(count % 100)) {
        "записей"
    } else {
        match count % 10 {
            1 => "запись",
            2..=4 => "записи",
            _ => "записей",
        }
    }
}
rusterize::export_app!(App);

#[cfg(test)]
mod tests {
    use super::*;
    fn node(x: f32, y: f32) -> Node {
        Node {
            name: "Лес".into(),
            position: Point::new(x, y),
            count: 3,
            lucid: 2,
            image: None,
        }
    }
    #[test]
    fn camera_transform_and_zoom_anchor_round_trip() {
        let mut a = Atlas {
            viewport: Viewport::new(390.0, 520.0, 3.0),
            ..Atlas::default()
        };
        a.pan = Point::new(70.0, -20.0);
        let point = Point::new(200.0, 300.0);
        let screen = a.screen(point);
        let round = a.world(screen);
        assert!((round.x - point.x).abs() < 0.001 && (round.y - point.y).abs() < 0.001);
        a.zoom_at(2.0, screen);
        let zoomed = a.screen(point);
        assert!((zoomed.x - screen.x).abs() < 0.001 && (zoomed.y - screen.y).abs() < 0.001);
    }
    #[test]
    fn cancelled_drag_restores_position() {
        let mut a = Atlas::default();
        a.nodes.push(node(220.0, 180.0));
        a.pointer = Some(Interaction {
            id: 7,
            node: Some(0),
            down: Point::default(),
            origin: Point::new(100.0, 100.0),
            moved: true,
        });
        a.cancel();
        assert_eq!(a.nodes[0].position, Point::new(100.0, 100.0));
        assert!(a.pointer.is_none());
    }
    #[test]
    fn character_stays_on_known_route() {
        let mut a = Atlas {
            nodes: vec![node(200.0, 200.0), node(800.0, 500.0)],
            ..Atlas::default()
        };
        a.characters.push(Character {
            name: "Друг".into(),
            homes: vec![0, 1],
            image: None,
        });
        for t in 0..1000 {
            a.time = t as f32;
            let p = a.character_position(0).unwrap();
            assert!((128.0..=872.0).contains(&p.x));
            assert!((232.0..=564.0).contains(&p.y));
        }
    }
    #[test]
    fn node_scene_passes_rusterize_validation() {
        let mut scene = Scene::default();
        let mut c = Canvas::new(&mut scene);
        c.clear(BG);
        for i in 0..3 {
            draw_node(&mut c, &node(150.0 + i as f32 * 160.0, 160.0), i, true);
        }
        c.finish().unwrap();
        assert!(scene.commands().len() > 50);
    }
}
