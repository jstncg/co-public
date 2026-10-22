import XCTest
import SwiftUI
@testable import Co

/// The mascot is generated data plus four pure functions. The data has to match what the
/// generator promises, and the four functions have to hold at their endpoints — everything the
/// canvas draws is built out of those.
final class MascotTests: XCTestCase {

    // MARK: The generated data

    /// `scripts/extract_mascot.py` asserts this shape before it writes; assert it after, so a
    /// hand edit to the "do not edit by hand" file cannot land quietly.
    func testEveryExpressionIsTwoRingsOfFortyEightPoints() {
        XCTAssertEqual(MascotData.expressions.count, 25)
        for expression in MascotData.expressions {
            XCTAssertEqual(expression.count, 2)
            XCTAssertTrue(expression.allSatisfy { $0.count == 48 })
        }
    }

    func testEveryStateHasASpecAndEveryPoolIsInRange() {
        for state in MascotState.allCases {
            let spec = state.spec  // force-unwraps; this test is what makes that safe
            XCTAssertFalse(spec.pool.isEmpty, "\(state.rawValue) has no expressions")
            XCTAssertTrue(spec.pool.allSatisfy { $0 >= 0 && $0 < MascotData.expressions.count },
                          "\(state.rawValue) points outside the expression table")
            XCTAssertLessThanOrEqual(spec.expressionCadence.lowerBound,
                                     spec.expressionCadence.upperBound)
        }
        XCTAssertEqual(MascotData.states.count, MascotState.allCases.count)
    }

    func testSilhouettesCarryFourCornersEach() {
        XCTAssertEqual(MascotSilhouette.all.count, 18)
        for shape in MascotSilhouette.all {
            XCTAssertEqual(shape.radii.h.count, 4, shape.name)
            XCTAssertEqual(shape.radii.v.count, 4, shape.name)
            XCTAssertGreaterThan(shape.faceScale, 0, shape.name)
        }
        XCTAssertEqual(MascotSilhouette.blob.radii.h, [0.5, 0.5, 0.5, 0.5])
    }

    // MARK: The morph

    func testMorphRampsFromZeroToSettled() {
        XCTAssertEqual(MascotGeometry.morph(0), 0)
        XCTAssertEqual(MascotGeometry.morph(-1), 0, "a morph cannot start before it starts")
        XCTAssertGreaterThan(MascotGeometry.morph(0.2), 0)
        XCTAssertLessThan(MascotGeometry.morph(0.2), 1)
        XCTAssertEqual(MascotGeometry.morph(2), 1, accuracy: 0.0001)
        XCTAssertLessThanOrEqual(MascotGeometry.morph(10), 1, "critically damped: no overshoot")
    }

    func testMorphOnlyEverMovesForward() {
        var previous = MascotGeometry.morph(0)
        for step in 1...60 {
            let next = MascotGeometry.morph(Double(step) / 60)
            XCTAssertGreaterThanOrEqual(next, previous)
            previous = next
        }
    }

    // MARK: The blink

    func testBlinkShutsThenOpensAndNeverFullyCloses() {
        XCTAssertEqual(MascotGeometry.blinkScale(0), 1)
        XCTAssertEqual(MascotGeometry.blinkScale(1), 1, "past the end the eye is open again")
        XCTAssertEqual(MascotGeometry.blinkScale(2), 1)
        XCTAssertEqual(MascotGeometry.blinkScale(0.42), 0.04, accuracy: 0.0001, "the shut point")
        for step in 0...100 {
            XCTAssertGreaterThanOrEqual(MascotGeometry.blinkScale(Double(step) / 100), 0.04)
        }
    }

    // MARK: Blending

    func testSilhouetteBlendLandsHalfwayOnEveryDimension() {
        let blob = MascotSilhouette.blob
        let tablet = MascotSilhouette.byName["tablet"]!
        let half = MascotSilhouette.lerp(blob, tablet, 0.5)

        XCTAssertEqual(half.scale.height,
                       (blob.scale.height + tablet.scale.height) / 2, accuracy: 0.0001)
        XCTAssertEqual(half.faceScale,
                       (blob.faceScale + tablet.faceScale) / 2, accuracy: 0.0001)
        XCTAssertEqual(half.radii.h[0], (blob.radii.h[0] + tablet.radii.h[0]) / 2, accuracy: 0.0001)
    }

    func testSilhouetteBlendPinsItsEnds() {
        let bean = MascotSilhouette.byName["bean"]!
        XCTAssertEqual(MascotSilhouette.lerp(.blob, bean, 0), .blob)
        XCTAssertEqual(MascotSilhouette.lerp(.blob, bean, 1), bean)
        // A flip has no halfway pose, so it lands with the rest of the morph, not before it.
        XCTAssertFalse(MascotSilhouette.lerp(.blob, bean, 0.49).mirrored)
        XCTAssertTrue(MascotSilhouette.lerp(.blob, bean, 0.51).mirrored)
    }

    // MARK: The body path

    func testEveryBodyPathFillsItsBox() {
        for shape in MascotSilhouette.all {
            let bounds = shape.bodyPath().boundingRect
            XCTAssertEqual(bounds.width, shape.bodyRect.width, accuracy: 0.5, shape.name)
            XCTAssertEqual(bounds.height, shape.bodyRect.height, accuracy: 0.5, shape.name)
            XCTAssertEqual(bounds.midX, shape.bodyRect.midX, accuracy: 0.5, shape.name)
        }
    }

    /// Six of the eighteen shapes ask for more corner than their edge has. CSS shrinks every
    /// radius by one factor; unscaled, the bottom edge runs backwards and fills a notch. The
    /// bounding box is identical either way, so `testEveryBodyPathFillsItsBox` cannot see it.
    func testOverflowingCornersShrinkTogether() {
        let radii = MascotSilhouette.byName["shield"]!.radii
        XCTAssertGreaterThan(radii.h[2] + radii.h[3], 1, "the source really does overflow here")

        let fitted = radii.fitted
        XCTAssertEqual(fitted.h[2] + fitted.h[3], 1, accuracy: 0.0001, "the worst edge lands at 1")
        // One factor for every corner, so the silhouette keeps its proportions.
        XCTAssertEqual(fitted.h[0] / radii.h[0], fitted.h[2] / radii.h[2], accuracy: 0.0001)
        XCTAssertEqual(fitted.v[1] / radii.v[1], fitted.h[2] / radii.h[2], accuracy: 0.0001)
    }

    /// Walks the real path rather than the radii, so it fails if `path(in:radii:)` ever stops
    /// fitting them. Each of the four straight edges has exactly one direction it may run in;
    /// an overflowing corner pair is precisely an edge that runs the other way.
    func testNoSilhouetteEverDrawsAnEdgeBackwards() {
        for shape in MascotSilhouette.all {
            var current = CGPoint.zero
            var edges: [CGVector] = []
            shape.bodyPath().forEach { element in
                switch element {
                case .move(let to): current = to
                case .line(let to):
                    edges.append(CGVector(dx: to.x - current.x, dy: to.y - current.y))
                    current = to
                case .curve(let to, _, _): current = to
                case .quadCurve(let to, _): current = to
                case .closeSubpath: break
                }
            }
            XCTAssertEqual(edges.count, 4, shape.name)
            XCTAssertGreaterThanOrEqual(edges[0].dx, -0.001, "\(shape.name) top runs backwards")
            XCTAssertGreaterThanOrEqual(edges[1].dy, -0.001, "\(shape.name) right runs backwards")
            XCTAssertLessThanOrEqual(edges[2].dx, 0.001, "\(shape.name) bottom runs backwards")
            XCTAssertLessThanOrEqual(edges[3].dy, 0.001, "\(shape.name) left runs backwards")
        }
    }

    /// A blend of two fitted shapes is itself fitted — the sums are convex — so nothing has to
    /// re-check mid-morph.
    func testABlendOfTwoShapesNeverOverflows() {
        for a in MascotSilhouette.all {
            for t in stride(from: 0.0, through: 1.0, by: 0.25) {
                let blended = MascotSilhouette.lerp(a, .blob, CGFloat(t)).radii.fitted
                XCTAssertLessThanOrEqual(blended.h[2] + blended.h[3], 1.0001, a.name)
            }
        }
    }

    func testACircleRadiusRoundsAllTheWay() {
        // 50% on every corner is a circle: the box's mid-edge is on the path, its corner is not.
        let box = CGRect(x: 0, y: 0, width: 100, height: 100)
        let circle = MascotSilhouette.path(in: box, radii: .init(h: [0.5, 0.5, 0.5, 0.5],
                                                                 v: [0.5, 0.5, 0.5, 0.5]))
        XCTAssertTrue(circle.contains(CGPoint(x: 50, y: 50)))
        XCTAssertFalse(circle.contains(CGPoint(x: 2, y: 2)), "a corner survived the rounding")
    }

    // MARK: The eyes on the sphere

    func testBlinkFlattensTheEyeWithoutMovingIt() {
        let ring = MascotData.expressions[0][0]
        let centroid = MascotRenderer.centroid(ring)
        let open = MascotRenderer.eyeTransform(ring: ring, blink: 1, gaze: .zero, turn: 0)!
        let shut = MascotRenderer.eyeTransform(ring: ring, blink: 0.04, gaze: .zero, turn: 0)!
        XCTAssertEqual(shut.a, open.a, accuracy: 0.0001, "a blink is vertical only")
        XCTAssertLessThan(shut.d, open.d * 0.1)
        // The lid collapses onto the eye's own centre rather than sliding up the face.
        XCTAssertEqual(centroid.applying(shut).y, centroid.applying(open).y, accuracy: 0.0001)
        XCTAssertEqual(centroid.applying(shut).x, centroid.applying(open).x, accuracy: 0.0001)
    }

    func testGazeMovesBothEyesTogether() {
        let rings = MascotData.expressions[0]
        let straight = rings.map { MascotRenderer.eyeTransform(ring: $0, blink: 1, gaze: .zero,
                                                               turn: 0)! }
        let right = rings.map {
            MascotRenderer.eyeTransform(ring: $0, blink: 1,
                                        gaze: CGSize(width: 1, height: 0), turn: 0)!
        }
        for (a, b) in zip(straight, right) {
            XCTAssertEqual(b.tx - a.tx, MascotGeometry.gazeSpan.width, accuracy: 0.0001)
        }
    }

    func testATurnCarriesAnEyeRoundTheBackAndStopsDrawingIt() {
        let ring = MascotData.expressions[0][0]
        XCTAssertNotNil(MascotRenderer.eyeTransform(ring: ring, blink: 1, gaze: .zero, turn: 0))
        XCTAssertNil(MascotRenderer.eyeTransform(ring: ring, blink: 1, gaze: .zero,
                                                 turn: .pi / 2 + 0.2),
                     "past the horizon the eye must stop drawing, not mirror back")
    }

    func testTheEyesSitOnTheSphereTheSourceAuthoredThemOn() {
        // Every centroid must be reachable by the sphere, or the longitude maths clamps and the
        // turn stops reading as a turn.
        for expression in MascotData.expressions {
            for ring in expression {
                let offset = abs(MascotRenderer.centroid(ring).x - MascotGeometry.sphereCenter)
                XCTAssertLessThanOrEqual(offset, MascotGeometry.sphereRadius)
            }
        }
    }

    // MARK: The driver

    @MainActor
    func testSelectingAnExpressionStartsFromWhereTheEyesActuallyAre() {
        let driver = MascotDriver()
        let start = Date()
        driver.select(4, at: start)

        // Interrupted a third of the way: the new morph has to begin at the pose on screen,
        // never at expression 4's finished shape.
        let midway = start.addingTimeInterval(0.06)
        let interrupted = driver.rings(at: midway)
        driver.select(9, at: midway)

        XCTAssertEqual(driver.rings(at: midway)[0][0].x, interrupted[0][0].x, accuracy: 0.0001)
        XCTAssertEqual(driver.rings(at: midway.addingTimeInterval(3))[0][0].x,
                       MascotData.expressions[9][0][0].x, accuracy: 0.0001)
    }

    @MainActor
    func testTheSilhouetteBlendsRatherThanCuts() {
        let driver = MascotDriver()
        let start = Date()
        let tablet = MascotSilhouette.byName["tablet"]!
        driver.morph(to: tablet, at: start)

        let early = driver.silhouette(at: start.addingTimeInterval(0.05))
        XCTAssertNotEqual(early.scale.height, MascotSilhouette.blob.scale.height)
        XCTAssertNotEqual(early.scale.height, tablet.scale.height)
        XCTAssertEqual(driver.silhouette(at: start.addingTimeInterval(3)).scale.height,
                       tablet.scale.height, accuracy: 0.0001)
    }

    @MainActor
    func testANewStateWearsAFaceFromItsOwnPool() {
        let driver = MascotDriver()
        for state in MascotState.allCases {
            driver.select(state.spec.pool[0])
            XCTAssertTrue(state.spec.pool.contains(driver.expression), state.rawValue)
        }
    }

    /// A still control shows one frozen face, so that face has to be one that looks at you.
    /// `idle`'s two both look away, which is fine at 190pt and reads as a misdraw at 44.
    func testTheRestingFaceLooksAtYou() {
        let ring = MascotData.expressions[MascotState.resting.spec.pool[0]]
        let pair = ring.map { MascotRenderer.centroid($0) }
        let midX = (pair[0].x + pair[1].x) / 2
        XCTAssertEqual(midX, MascotGeometry.sphereCenter, accuracy: 20)
        XCTAssertEqual((pair[0].y + pair[1].y) / 2, MascotGeometry.box / 2, accuracy: 20)
    }

    // MARK: Head space → the canvas

    /// Where the eye lands: authored centroid, pulled 82% of the way in toward the head centre
    /// by `tablet`'s face scale, reflected because `tablet` is mirrored, then fitted to 128pt.
    func testTheEyeLandsWhereTheShapeAndTheCanvasPutIt() throws {
        let tablet = MascotSilhouette.byName["tablet"]!
        let ring = MascotData.expressions[10][0]
        let size = CGSize(width: 128, height: 128)
        let unit = 128 / MascotGeometry.box
        let centre = MascotGeometry.box / 2

        let landed = MascotRenderer.centroid(ring)
            .applying(try XCTUnwrap(MascotRenderer.eyeToView(
                ring: ring, blink: 1, gaze: .zero, turn: 0, silhouette: tablet, size: size)))

        let authored = MascotRenderer.centroid(ring)
        let shrunk = CGPoint(x: centre + (authored.x - centre) * tablet.faceScale,
                             y: centre + (authored.y - centre) * tablet.faceScale)
        XCTAssertEqual(landed.x, (MascotGeometry.box - shrunk.x) * unit, accuracy: 0.01)
        XCTAssertEqual(landed.y, shrunk.y * unit, accuracy: 0.01)
    }

    /// The one composition a reader would plausibly get backwards: the eye is PLACED in head
    /// space first, and only then handed to the shape and the canvas. Composing it the other
    /// way round makes a closing eye slide toward the head centre as it shuts.
    ///
    /// It has to be checked with a blink or a turn on. Straight on and wide open the placement
    /// is the identity transform, and both orders agree — which is exactly how this bug would
    /// reach the screen past a test that only ever looks at a resting face.
    func testABlinkNeverSlidesTheEyeOnAnyShape() throws {
        let size = CGSize(width: 128, height: 128)
        for silhouette in MascotSilhouette.all {
            for ring in MascotData.expressions[10] {
                let centroid = MascotRenderer.centroid(ring)
                let open = try XCTUnwrap(MascotRenderer.eyeToView(
                    ring: ring, blink: 1, gaze: .zero, turn: 0.35,
                    silhouette: silhouette, size: size))
                let shut = try XCTUnwrap(MascotRenderer.eyeToView(
                    ring: ring, blink: 0.04, gaze: .zero, turn: 0.35,
                    silhouette: silhouette, size: size))
                XCTAssertEqual(centroid.applying(shut).x, centroid.applying(open).x,
                               accuracy: 0.01, silhouette.name)
                XCTAssertEqual(centroid.applying(shut).y, centroid.applying(open).y,
                               accuracy: 0.01, silhouette.name)
            }
        }
    }

    func testAMirroredShapeFlipsTheBodyAndTheEyesTogether() {
        let size = CGSize(width: 128, height: 128)
        let cloud = MascotSilhouette.byName["cloud"]!
        XCTAssertTrue(cloud.mirrored)

        let head = MascotRenderer.headToView(size: size, silhouette: cloud)
        let face = MascotRenderer.faceToView(size: size, silhouette: cloud)
        XCTAssertLessThan(head.a, 0, "a mirrored body must flip in x")
        XCTAssertLessThan(face.a, 0, "the eyes must flip with it, never against it")
    }

    // MARK: What actually reaches the screen
    //
    // Everything above checks the maths. These rasterise the real `Canvas` through
    // `ImageRenderer` and read the pixels back, which is the only check that fails if the
    // transforms compose in the wrong order or the paths come out empty.

    @MainActor
    func testTheFaceRasterisesBodyAndEyes() throws {
        let pixels = try raster(.blob, MascotData.expressions[0])
        XCTAssertGreaterThan(pixels.filter { $0 < 64 }.count, 20, "no ink — the eyes are missing")
        XCTAssertGreaterThan(pixels.filter { (100...200).contains($0) }.count, 200,
                             "no mid-grey — the body did not fill")
    }

    @MainActor
    func testTwoExpressionsRasteriseDifferently() throws {
        XCTAssertNotEqual(try raster(.blob, MascotData.expressions[0]),
                          try raster(.blob, MascotData.expressions[10]))
    }

    @MainActor
    func testTwoSilhouettesRasteriseDifferently() throws {
        let rings = MascotData.expressions[10]
        XCTAssertNotEqual(try raster(.blob, rings),
                          try raster(MascotSilhouette.byName["tablet"]!, rings))
    }

    @MainActor
    func testABlinkShrinksTheInkWithoutErasingIt() throws {
        let rings = MascotData.expressions[10]
        let open = try raster(.blob, rings).filter { $0 < 64 }.count
        let shut = try raster(.blob, rings, blink: 0.04).filter { $0 < 64 }.count
        XCTAssertLessThan(shut, open / 2)
        XCTAssertGreaterThan(shut, 0, "a blink is a line, never an empty face")
    }

    @MainActor
    func testTurningRightCarriesTheEyesOffTheFace() throws {
        let rings = MascotData.expressions[10]
        let straight = try raster(.blob, rings).filter { $0 < 64 }.count
        let turned = try raster(.blob, rings, turn: 1.5).filter { $0 < 64 }.count
        XCTAssertLessThan(turned, straight)
    }

    /// 128×128 greyscale on white. Big enough that a shut lid is still more than one pixel tall
    /// — at 64 it antialiases to grey and "the eyes vanished" and "the eyes closed" look alike.
    @MainActor
    private func raster(_ silhouette: MascotSilhouette, _ rings: [[CGPoint]],
                        blink: CGFloat = 1, turn: CGFloat = 0) throws -> [UInt8] {
        let side = 128
        let renderer = ImageRenderer(content: Canvas { ctx, size in
            MascotRenderer.draw(ctx, size: size, silhouette: silhouette, rings: rings,
                                blink: blink, gaze: .zero, turn: turn)
        }
        .frame(width: CGFloat(side), height: CGFloat(side)))
        renderer.scale = 1

        let image = try XCTUnwrap(renderer.cgImage, "the canvas rendered nothing at all")
        var pixels = [UInt8](repeating: 0, count: side * side)
        // The whole context lives inside the closure: `&pixels` would only be a valid pointer
        // for the CGContext initialiser itself, and every draw after it writes through a
        // pointer whose lifetime has ended.
        try pixels.withUnsafeMutableBytes { buffer in
            let ctx = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: side, height: side,
                                              bitsPerComponent: 8, bytesPerRow: side,
                                              space: CGColorSpaceCreateDeviceGray(),
                                              bitmapInfo: CGImageAlphaInfo.none.rawValue))
            let box = CGRect(x: 0, y: 0, width: side, height: side)
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.fill(box)
            ctx.draw(image, in: box)
        }
        return pixels
    }
}
