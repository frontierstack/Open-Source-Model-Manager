import React, { useLayoutEffect, useRef, useState } from 'react';

// Keep in step with the .smooth-collapse transition in index.css.
const SETTLE_MS = 300;

// Height animation for a panel that used to mount and unmount on toggle. The
// content stays mounted until the close has finished, and is not mounted at all
// while closed. Pass a function as children when building them is expensive.
// A timer ends each phase, not transitionend (never fires under reduced motion)
// or requestAnimationFrame (stalls in a hidden tab).
export default function SmoothCollapse({ open, children }) {
    const [mounted, setMounted] = useState(open);
    const [expanded, setExpanded] = useState(open);
    const [settled, setSettled] = useState(open);
    const rootRef = useRef(null);
    const firstRun = useRef(true);

    useLayoutEffect(() => {
        if (firstRun.current) { firstRun.current = false; return undefined; }
        setSettled(false);
        if (open) setMounted(true); else setExpanded(false);
        const timer = setTimeout(() => {
            if (open) setSettled(true); else setMounted(false);
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [open]);

    // The forced layout commits the collapsed state, so the browser has a start
    // point to animate from. Also reverses a close that is still running.
    useLayoutEffect(() => {
        if (open && mounted && !expanded && rootRef.current) {
            rootRef.current.getBoundingClientRect();
            setExpanded(true);
        }
    }, [open, mounted, expanded]);

    if (!mounted) return null;
    return (
        <div ref={rootRef} className={`smooth-collapse${expanded ? ' is-open' : ''}${settled ? ' is-settled' : ''}`}>
            <div className="smooth-collapse-inner">
                {typeof children === 'function' ? children() : children}
            </div>
        </div>
    );
}
