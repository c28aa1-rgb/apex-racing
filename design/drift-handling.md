# Gear-driven drift handling

Manual driving now initiates power-oversteer with throttle and steering. The drift key is ignored in manual driving. Lower gears produce more rear slip; an upshift reduces it. Automatic driving retains its Shift drift binding and mild corner slip without Shift.

## Research references

- [Chelsea DeNofa: How to Drift in 5 Minutes, POV and foot camera](https://www.youtube.com/watch?v=apS2vUhvEDc), also in his [How To Drift playlist](https://www.youtube.com/playlist?list=PLEoTYw_iXSqsGHPhProOoQ5j6qAlxPR_p).
- [KameTrick: Drifting Tutorial for Beginners](https://www.youtube.com/watch?v=RtCfqohMhl0). These videos were located as visual references; full video playback and transcripts were unavailable through the research tools.
- [Team O'Neil: Weight Transfer](https://teamoneil.com/blog/weight-transfer/) describes rear-wheel power-oversteer, countersteering, and the importance of smooth inputs. It also distinguishes weight-transfer oversteer from power-oversteer.
- [BFGoodrich, Ross Bentley: Handling Characteristics & Cornering](https://www.bfgoodrichtires.com/auto/learn/performance-driving-guide/handling-characteristics-cornering) describes grip falling beyond the peak slip angle, shared tire traction, and easing the throttle to control power-oversteer.
- [MathWorks: Combined Slip Wheel 2DOF](https://www.mathworks.com/help/vdynblks/ref/combinedslipwheel2dof.html) documents coupled longitudinal and lateral tire forces. This game uses Rapier and an arcade assist, not a calibrated Magic Formula tire model.

## Translation into game behavior

Gear position supplies a decreasing drive-torque proxy. The existing engine model supplies rev load, lugging and over-rev limits. Throttle, brake, road speed and smoothed steering load determine breakaway. Shifts temporarily reduce the demand while the gearbox disengages. This intentionally gives the requested consistent lower-gear/more-slide relationship; real behavior also depends on engine torque, ratios and tires.

Existing 60 Hz pedal, steering, breakaway and yaw ramps handle transitions. Camera and rendered yaw retain frame interpolation. Framer Motion remains responsible for React interface motion; it does not drive vehicle dynamics.

At large body slip angles, the new assist reduces the part of the tire impulse that turns the travel direction. Body yaw can remain sideways while momentum carries the car wide. The existing traction budget, braking, collision response and spin protection remain active. Near-straight travel at maximum drift is an intentional arcade choice; real drifts can follow curves or spin out.

Start with manual driving, first or second gear, throttle and a sustained turn. Tap the opposite steering key to catch the rear. Lift or upshift to reduce the slide. Unsafe downshifts remain blocked. Zero drift strength disables the assist.

## Replay compatibility

`PHYSICS_VERSION` stays unchanged so existing times remain visible. New recordings carry `gearDrift: true`. Recordings without it use the original Shift-based handling, including old manual recordings. PostgreSQL stores this optional flag in a nullable column; Cloudflare stores it in the existing replay JSON. Four snapshots captured before the edit verify the original handling exactly.

## Verification

- The initial full suite passed all 203 Node tests, including seven new drift regression tests. Restoring Shift in automatic driving then passed all 37 focused handling tests and TypeScript checks.
- Every car is checked for low-gear drift, reduced slide in higher gears, countersteering and recovery.
- Maximum sliders are checked across all 11 cars, three gear positions and every weather preset for finite state, positive grip, contact and bounded acceleration.
- A maximum-drift reference maneuver retains over 45 degrees of body slip with less than 3 degrees/second of yaw.
- Browser keyboard checks produce about 40 degrees of slip in second gear and 25 degrees after an upshift to third. Lifting restores grip.
- Browser runs at 30, 60 and 144 FPS produce identical physics frames on desktop and mobile viewports.
- Production build and Cloudflare type check pass. No deployment was performed. Shift drift remains available only in automatic driving.

The numbers above are regression measurements, not proof of subjective driving feel. Final tuning still benefits from the player's feedback.
