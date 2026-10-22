import SwiftUI

// Co's face, ported from the GrokBot reverse-engineering gist. The numbers live in the
// generated `MascotData.swift`; the behaviour lives here.
//
// Three things move, and nothing else:
//   1. the EXPRESSION — two 48-point eye rings, sprung from the old pair to the new one,
//   2. the BLINK — a 320ms lid that never quite shuts,
//   3. the SILHOUETTE — a CSS-radius body that blends corner by corner into another.
//
// A STATE picks which expressions are eligible and how often they change. That is the whole
// reaction model: `listening` cycles three attentive faces every 2.8–5s and blinks every
// 3–7s; `searching` runs six faces at 1–1.8s. Nothing hand-animates a mood.

// MARK: - Shapes the generated data fills

/// Per-corner CSS radii as fractions of the body box — `h` of its width, `v` of its height —
/// in CSS order: top-left, top-right, bottom-right, bottom-left.
struct MascotRadii: Equatable, Sendable {
    var h: [CGFloat]
    var v: [CGFloat]

    static func lerp(_ a: MascotRadii, _ b: MascotRadii, _ t: CGFloat) -> MascotRadii {
        MascotRadii(h: zip(a.h, b.h).map { $0 + ($1 - $0) * t },
                    v: zip(a.v, b.v).map { $0 + ($1 - $0) * t })
    }

    /// When the two radii on one edge want more than the edge has, CSS shrinks EVERY radius by
    /// the one worst factor, so the shape keeps its proportions (CSS Backgrounds §5.5). Six of
    /// the source's eighteen do overflow — `pebble`, `bean`, `egg`, `shield`, `cloud`,
    /// `teardrop` — and unscaled their bottom edge runs backwards, filling a notch where a
    /// corner should be. The browser the gist was authored in did this for free.
    var fitted: MascotRadii {
        let worst = max(h[0] + h[1], h[2] + h[3], v[1] + v[2], v[3] + v[0], 1)
        guard worst > 1 else { return self }
        return MascotRadii(h: h.map { $0 / worst }, v: v.map { $0 / worst })
    }
}

/// One body shape. Every field except `name` and `mirrored` interpolates, which is what makes
/// blob → tablet a morph rather than a cut.
struct MascotSilhouette: Equatable, Sendable, Identifiable {
    let name: String
    /// Head-space nudge; `wedge` and `teardrop` sit low in their box.
    let offset: CGPoint
    let scale: CGSize
    /// The eyes shrink with the body: a bean's face is not a blob's face at the same size.
    let faceScale: CGFloat
    /// The source only ever prints this as a catalogue metric ("turnAt"), so the meaning is
    /// inferred: the asymmetric shapes read as authored facing the other way.
    let mirrored: Bool
    let radii: MascotRadii

    var id: String { name }

    static let all = MascotData.silhouettes
    static let byName = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })
    static let blob = byName["blob"]!

    static func lerp(_ a: MascotSilhouette, _ b: MascotSilhouette, _ t: CGFloat) -> MascotSilhouette {
        guard t > 0 else { return a }
        guard t < 1 else { return b }
        return MascotSilhouette(
            name: b.name,
            offset: CGPoint(x: a.offset.x + (b.offset.x - a.offset.x) * t,
                            y: a.offset.y + (b.offset.y - a.offset.y) * t),
            scale: CGSize(width: a.scale.width + (b.scale.width - a.scale.width) * t,
                          height: a.scale.height + (b.scale.height - a.scale.height) * t),
            faceScale: a.faceScale + (b.faceScale - a.faceScale) * t,
            // A flip has no halfway pose, so it lands with the rest of the morph.
            mirrored: t < 0.5 ? a.mirrored : b.mirrored,
            radii: .lerp(a.radii, b.radii, t))
    }
}

extension MascotState {
    /// The face a STILL control wears. Not `idle`: the source authors each expression's gaze
    /// into the point positions, and idle's two faces both look away — right for a 190pt avatar
    /// that should not stare, wrong on a 44pt disc, where an off-centre pair reads as a misdraw.
    /// `listening`'s first face is the one pair the source centres, and it is what the footer
    /// disc should be promising anyway.
    static let resting = MascotState.listening
}

struct MascotStateSpec: Sendable {
    /// Indices into `MascotData.expressions`. The state cycles these and only these.
    let pool: [Int]
    let expressionCadence: ClosedRange<Double>
    /// nil where the state does not blink at all — `sleeping`, `powering-down`.
    let blinkCadence: ClosedRange<Double>?
    let group: String
}

// MARK: - The source's geometry, in one place

enum MascotGeometry {
    /// The source SVG's head box: 228.541 units square, every eye point authored inside it.
    static let box: CGFloat = 228.541
    /// The eyes ride a sphere, which is what makes a head turn read as a turn and not a slide.
    static let sphereCenter: CGFloat = 114.2705
    static let sphereRadius: CGFloat = 105
    /// Gaze input (-1…1 per axis) → head units.
    static let gazeSpan = CGSize(width: 13.2, height: 8.4)
    /// The source's default spring frequency, critically damped.
    static let morphFrequency: Double = 7
    static let blinkDuration: Double = 0.32
    /// Below this the eye is round the back of the head and stops drawing.
    static let depthCutoff: CGFloat = 0.02

    /// Closed form of the source's spring (`v' = -2fv - f²(m-1)`, `m(0)=0`, `v(0)=0`), so a
    /// frame needs elapsed time alone — never the previous frame's velocity.
    static func morph(_ elapsed: Double) -> CGFloat {
        guard elapsed > 0 else { return 0 }
        let ft = morphFrequency * elapsed
        return min(CGFloat(1 - (1 + ft) * exp(-ft)), 1)
    }

    /// `t` is progress through `blinkDuration`: shut over the first 42%, open over the rest,
    /// bottoming at 0.04 so the lid stays a line instead of vanishing.
    static func blinkScale(_ t: Double) -> CGFloat {
        guard t > 0, t < 1 else { return 1 }
        return max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
    }
}

// MARK: - Body path

extension MascotSilhouette {
    /// CSS `border-radius` as a path: four elliptical corners, cubic-approximated.
    static func path(in rect: CGRect, radii: MascotRadii) -> Path {
        let k: CGFloat = 0.5522847498307936  // circle-to-cubic constant
        let fitted = radii.fitted
        let rx = fitted.h.map { $0 * rect.width }
        let ry = fitted.v.map { $0 * rect.height }
        let (l, t, r, b) = (rect.minX, rect.minY, rect.maxX, rect.maxY)

        var p = Path()
        p.move(to: CGPoint(x: l + rx[0], y: t))
        p.addLine(to: CGPoint(x: r - rx[1], y: t))
        p.addCurve(to: CGPoint(x: r, y: t + ry[1]),
                   control1: CGPoint(x: r - rx[1] + k * rx[1], y: t),
                   control2: CGPoint(x: r, y: t + ry[1] - k * ry[1]))
        p.addLine(to: CGPoint(x: r, y: b - ry[2]))
        p.addCurve(to: CGPoint(x: r - rx[2], y: b),
                   control1: CGPoint(x: r, y: b - ry[2] + k * ry[2]),
                   control2: CGPoint(x: r - rx[2] + k * rx[2], y: b))
        p.addLine(to: CGPoint(x: l + rx[3], y: b))
        p.addCurve(to: CGPoint(x: l, y: b - ry[3]),
                   control1: CGPoint(x: l + rx[3] - k * rx[3], y: b),
                   control2: CGPoint(x: l, y: b - ry[3] + k * ry[3]))
        p.addLine(to: CGPoint(x: l, y: t + ry[0]))
        p.addCurve(to: CGPoint(x: l + rx[0], y: t),
                   control1: CGPoint(x: l, y: t + ry[0] - k * ry[0]),
                   control2: CGPoint(x: l + rx[0] - k * rx[0], y: t))
        p.closeSubpath()
        return p
    }

    /// The body box in head space: the full square, scaled about its centre, then nudged.
    var bodyRect: CGRect {
        let c = MascotGeometry.box / 2
        let w = MascotGeometry.box * scale.width
        let h = MascotGeometry.box * scale.height
        return CGRect(x: c - w / 2 + offset.x, y: c - h / 2 + offset.y, width: w, height: h)
    }

    func bodyPath() -> Path { Self.path(in: bodyRect, radii: radii) }
}

// MARK: - Renderer

enum MascotRenderer {
    /// Where one eye ring lands, in head space. `nil` when the turn has carried it out of sight.
    ///
    /// Straight from the source: the ring's own centroid gives its longitude on the sphere, the
    /// turn adds to it, and the cosine of the result both narrows the eye and fades it out.
    static func eyeTransform(ring: [CGPoint], blink: CGFloat, gaze: CGSize,
                             turn: CGFloat) -> CGAffineTransform? {
        let c = centroid(ring)
        let baseLongitude = asin(clamp((c.x - MascotGeometry.sphereCenter)
                                        / MascotGeometry.sphereRadius, -1, 1))
        let longitude = baseLongitude + turn
        let depth = cos(longitude)
        guard depth > MascotGeometry.depthCutoff else { return nil }

        let perspective = max(depth, MascotGeometry.depthCutoff)
            / max(cos(baseLongitude), MascotGeometry.depthCutoff)
        let x = MascotGeometry.sphereCenter + MascotGeometry.sphereRadius * sin(longitude)
            + gaze.width * MascotGeometry.gazeSpan.width
        let y = c.y + gaze.height * MascotGeometry.gazeSpan.height

        return CGAffineTransform(translationX: -c.x, y: -c.y)
            .concatenating(CGAffineTransform(scaleX: clamp(perspective, 0.02, 2.4),
                                             y: clamp(blink, 0.02, 2.4)))
            .concatenating(CGAffineTransform(translationX: x, y: y))
    }

    static func centroid(_ ring: [CGPoint]) -> CGPoint {
        let n = CGFloat(ring.count)
        return ring.reduce(into: CGPoint.zero) { $0.x += $1.x / n; $0.y += $1.y / n }
    }

    static func clamp(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
        min(max(v, lo), hi)
    }

    /// Head space → view points: the canvas fits the 228.541 box into the smaller side and
    /// centres it, then a mirrored silhouette flips about the box.
    static func headToView(size: CGSize, silhouette: MascotSilhouette) -> CGAffineTransform {
        let unit = min(size.width, size.height) / MascotGeometry.box
        let fit = CGAffineTransform(
            translationX: (size.width - MascotGeometry.box * unit) / 2,
            y: (size.height - MascotGeometry.box * unit) / 2)
            .scaledBy(x: unit, y: unit)
        // A flip about the head box, exactly as the source flips its two groups together.
        guard silhouette.mirrored else { return fit }
        return CGAffineTransform(scaleX: -1, y: 1)
            .concatenating(CGAffineTransform(translationX: MascotGeometry.box, y: 0))
            .concatenating(fit)
    }

    /// The eyes ride the body: the shape's face scale shrinks them toward the head centre and
    /// its nudge carries them with it.
    static func faceToView(size: CGSize, silhouette: MascotSilhouette) -> CGAffineTransform {
        let c = MascotGeometry.box / 2
        return CGAffineTransform(translationX: -c, y: -c)
            .concatenating(CGAffineTransform(scaleX: silhouette.faceScale,
                                             y: silhouette.faceScale))
            .concatenating(CGAffineTransform(translationX: c + silhouette.offset.x,
                                             y: c + silhouette.offset.y))
            .concatenating(headToView(size: size, silhouette: silhouette))
    }

    /// One eye, all the way from its authored ring to the pixel it lands on.
    ///
    /// The order is load-bearing and not obvious: the eye is PLACED in head space first — that
    /// is where the sphere, the blink and the gaze all live — and only then handed to the face
    /// and the canvas. Composing it the other way round is silently correct for a `blob` seen
    /// straight on (both scales are 1 there) and wrong for every shape and every turn.
    static func eyeToView(ring: [CGPoint], blink: CGFloat, gaze: CGSize, turn: CGFloat,
                          silhouette: MascotSilhouette, size: CGSize) -> CGAffineTransform? {
        guard let placed = eyeTransform(ring: ring, blink: blink, gaze: gaze, turn: turn) else {
            return nil
        }
        return placed.concatenating(faceToView(size: size, silhouette: silhouette))
    }

    static func draw(_ ctx: GraphicsContext, size: CGSize, silhouette: MascotSilhouette,
                     rings: [[CGPoint]], blink: CGFloat, gaze: CGSize, turn: CGFloat) {
        let body = silhouette.bodyPath()
            .applying(headToView(size: size, silhouette: silhouette))
        ctx.fill(body, with: .linearGradient(
            Gradient(colors: [CoColor.powder.color, CoColor.watercolor.color]),  // design: DESIGN_SYSTEM.md §10
            startPoint: .zero, endPoint: CGPoint(x: size.width, y: size.height)))

        // Clipped to the body, so a turned-away eye slides off the edge instead of floating.
        var eyes = ctx
        eyes.clip(to: body)
        for ring in rings {
            guard let t = eyeToView(ring: ring, blink: blink, gaze: gaze, turn: turn,
                                    silhouette: silhouette, size: size) else { continue }
            var p = Path()
            p.addLines(ring)
            p.closeSubpath()
            eyes.fill(p.applying(t), with: .color(CoColor.ink.color))  // design: DESIGN_SYSTEM.md §10
        }
    }
}

// MARK: - Driver

/// Holds what a frame cannot recompute: which expression we left, which we are heading to, and
/// when the last blink started. Every pose is then a pure function of `Date`, which is why the
/// canvas can redraw at display rate without owning any animation state.
@MainActor
@Observable
final class MascotDriver {
    /// The one thing the view reads directly: the still branch draws this expression outright
    /// instead of a morphed pose.
    private(set) var expression = 0

    private var state: MascotState = .idle
    private var fromRings = MascotData.expressions[0]
    private var morphStart = Date.distantPast
    private var blinkStart: Date?

    private var fromSilhouette = MascotSilhouette.blob
    private var targetSilhouette = MascotSilhouette.blob
    private var silhouetteStart = Date.distantPast

    // MARK: Pose at a moment

    func rings(at date: Date) -> [[CGPoint]] {
        let target = MascotData.expressions[expression]
        let t = MascotGeometry.morph(date.timeIntervalSince(morphStart))
        guard t < 1 else { return target }
        return zip(fromRings, target).map { from, to in
            zip(from, to).map { p, q in
                CGPoint(x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t)
            }
        }
    }

    func blink(at date: Date) -> CGFloat {
        guard let blinkStart else { return 1 }
        return MascotGeometry.blinkScale(
            date.timeIntervalSince(blinkStart) / MascotGeometry.blinkDuration)
    }

    func silhouette(at date: Date) -> MascotSilhouette {
        MascotSilhouette.lerp(fromSilhouette, targetSilhouette,
                              MascotGeometry.morph(date.timeIntervalSince(silhouetteStart)))
    }

    // MARK: Changes

    /// Interrupts cleanly: the morph restarts from where the eyes actually are, not from the
    /// expression we were nominally showing.
    func select(_ index: Int, at date: Date = Date()) {
        fromRings = rings(at: date)
        expression = index
        morphStart = date
    }

    func morph(to silhouette: MascotSilhouette, at date: Date = Date()) {
        guard silhouette != targetSilhouette else { return }
        fromSilhouette = self.silhouette(at: date)
        targetSilhouette = silhouette
        silhouetteStart = date
    }

    /// Drive one state until cancelled. Owns both cadences; `.task(id:)` restarts it on change.
    func run(_ state: MascotState) async {
        self.state = state
        select(state.spec.pool[0])
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.cycleExpressions() }
            group.addTask { await self.cycleBlinks() }
        }
    }

    private func cycleExpressions() async {
        while !Task.isCancelled {
            let spec = state.spec
            try? await Task.sleep(for: .seconds(Double.random(in: spec.expressionCadence)))
            guard !Task.isCancelled else { return }
            // Never the face we are already wearing — a repeat reads as a freeze. A
            // single-expression pool (`waking`) has nowhere else to go and holds instead.
            guard let next = spec.pool.filter({ $0 != expression }).randomElement() else { continue }
            select(next)
        }
    }

    private func cycleBlinks() async {
        while !Task.isCancelled {
            guard let cadence = state.spec.blinkCadence else { return }
            try? await Task.sleep(for: .seconds(Double.random(in: cadence)))
            guard !Task.isCancelled else { return }
            blinkStart = Date()
        }
    }
}

// MARK: - The view

/// Co's face. Give it a state and it behaves; give it a silhouette and it blends there.
struct CoMascot: View {
    var state: MascotState = .idle
    var silhouette: MascotSilhouette = .blob
    var size: CGFloat = 150
    /// False where the face is chrome (the footer disc): the only thing moving on a still
    /// screen is noise, and a canvas redrawing at display rate for decoration is worse.
    var animated = true
    /// Where the eyes look, each axis -1…1.
    var gaze: CGSize = .zero
    /// Head turn in radians. Past ~±1.4 the far eye is round the back and stops drawing.
    var turn: CGFloat = 0

    @State private var driver = MascotDriver()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isLive: Bool { animated && !reduceMotion }

    var body: some View {
        Group {
            if isLive {
                TimelineView(.animation) { timeline in
                    canvas(silhouette: driver.silhouette(at: timeline.date),
                           rings: driver.rings(at: timeline.date),
                           blink: driver.blink(at: timeline.date))
                }
            } else {
                // Settled: the target shape, the state's own first face, eyes open. It reads
                // the pool rather than the driver on purpose — the driver still says expression
                // 0 until `.task` runs, which is a frame later, and expression 0 is the
                // looking-away pair that `.resting` exists to avoid.
                canvas(silhouette: silhouette,
                       rings: MascotData.expressions[state.spec.pool[0]],
                       blink: 1)
            }
        }
        .frame(width: size, height: size)
        // Keyed on liveness as well as state, because the two change together and the values
        // can collide: leaving voice takes `listening` to `.resting`, which IS `listening`, so
        // an id of `state` alone leaves the cadence running under a face documented as still.
        .task(id: "\(state.rawValue)/\(isLive)") {
            guard isLive else { return }
            await driver.run(state)
        }
        .onAppear { driver.morph(to: silhouette) }
        .onChange(of: silhouette) { driver.morph(to: $1) }
        .accessibilityHidden(true)
    }

    private func canvas(silhouette: MascotSilhouette, rings: [[CGPoint]],
                        blink: CGFloat) -> some View {
        Canvas(opaque: false) { ctx, size in
            MascotRenderer.draw(ctx, size: size, silhouette: silhouette, rings: rings,
                                blink: blink, gaze: gaze, turn: turn)
        }
    }
}

#Preview("States") {
    ScrollView {
        LazyVGrid(columns: [.init(.adaptive(minimum: 110))], spacing: CoSpacing.l) {
            ForEach(MascotState.allCases, id: \.self) { state in
                VStack(spacing: CoSpacing.xs) {
                    CoMascot(state: state, size: 90)
                    Text(state.rawValue).font(CoType.style(.caption))
                }
            }
        }
        .padding(CoSpacing.l)
    }
}

#Preview("Silhouettes") {
    ScrollView {
        LazyVGrid(columns: [.init(.adaptive(minimum: 110))], spacing: CoSpacing.l) {
            ForEach(MascotSilhouette.all) { shape in
                VStack(spacing: CoSpacing.xs) {
                    CoMascot(state: .curious, silhouette: shape, size: 90)
                    Text(shape.name).font(CoType.style(.caption))
                }
            }
        }
        .padding(CoSpacing.l)
    }
}
