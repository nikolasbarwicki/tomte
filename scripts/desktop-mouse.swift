// Posts real mouse events for the desktop smokes (scripts/smoke-desktop-titlebar.ts), compiled with `swiftc` into the run's temp root:
//   desktop-mouse trusted [prompt] | click X Y | doubleclick X Y | drag X1 Y1 X2 Y2
// Coordinates are global screen points, origin at the top-left of the main display (the same space as Electron's
// `getBounds()`). The cursor goes back to where it was before, so a developer's pointer is not left in the app.
// Needs the Accessibility permission of the process that runs it; exits 2 when macOS refuses to post events.
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

if CommandLine.arguments.count >= 2, CommandLine.arguments[1] == "trusted" {
  // With `prompt`, macOS shows its normal Accessibility prompt for the process that runs this (the terminal), once; nothing is bypassed.
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: CommandLine.arguments.count >= 3] as CFDictionary
  print(AXIsProcessTrustedWithOptions(options))
  exit(0)
}

guard AXIsProcessTrusted() else { fail("not trusted for Accessibility: no events can be posted", code: 2) }

let args = CommandLine.arguments
guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
  fail("usage: desktop-mouse click|doubleclick X Y | drag X1 Y1 X2 Y2", code: 64)
}
let origin = CGEvent(source: nil)?.location ?? .zero
let source = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ at: CGPoint, clicks: Int64 = 1, delta: CGPoint = .zero, pause: UInt32 = 15_000) {
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left)!
  event.setIntegerValueField(.mouseEventClickState, value: clicks)
  // The window server's window-move tracking reads the deltas, not only the positions.
  event.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.x.rounded()))
  event.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.y.rounded()))
  event.post(tap: .cghidEventTap)
  usleep(pause)
}

func click(at point: CGPoint, count: Int64) {
  post(.mouseMoved, point)
  for n in 1...count {
    post(.leftMouseDown, point, clicks: n)
    post(.leftMouseUp, point, clicks: n)
  }
}

let start = CGPoint(x: x, y: y)
switch args[1] {
case "click":
  click(at: start, count: 1)
case "doubleclick":
  click(at: start, count: 2)
case "drag":
  guard args.count == 6, let x2 = Double(args[4]), let y2 = Double(args[5]) else {
    fail("usage: desktop-mouse drag X1 Y1 X2 Y2", code: 64)
  }
  post(.mouseMoved, start)
  post(.leftMouseDown, start, pause: 150_000)
  let steps = 20
  var last = start
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let next = CGPoint(x: x + (x2 - x) * t, y: y + (y2 - y) * t)
    post(.leftMouseDragged, next, delta: CGPoint(x: next.x - last.x, y: next.y - last.y), pause: 20_000)
    last = next
  }
  post(.leftMouseUp, CGPoint(x: x2, y: y2), pause: 100_000)
default:
  fail("unknown command \(args[1])", code: 64)
}
usleep(100_000)
CGWarpMouseCursorPosition(origin)
CGAssociateMouseAndMouseCursorPosition(1)
