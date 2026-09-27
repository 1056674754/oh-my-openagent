#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Transition {
    KeyDown(u16),
    KeyUp(u16),
    ButtonDown(u8),
    ButtonUp(u8),
    Other,
}

pub(super) fn pending_releases(events: &[Transition]) -> Vec<Transition> {
    let mut pending = Vec::new();
    for event in events {
        let (down, release) = match *event {
            Transition::KeyDown(key) => (true, Transition::KeyUp(key)),
            Transition::KeyUp(key) => (false, Transition::KeyUp(key)),
            Transition::ButtonDown(button) => (true, Transition::ButtonUp(button)),
            Transition::ButtonUp(button) => (false, Transition::ButtonUp(button)),
            Transition::Other => continue,
        };
        let previous = pending.iter().position(|held| held == &release);
        if down {
            if previous.is_none() {
                pending.push(release);
            }
        } else if let Some(index) = previous {
            pending.remove(index);
        }
    }
    pending
}

#[cfg(test)]
mod tests {
    use super::{pending_releases, Transition};

    #[test]
    fn releases_only_unmatched_downs_from_the_accepted_prefix() {
        let accepted = [
            Transition::KeyDown(17),
            Transition::KeyDown(65),
            Transition::KeyUp(65),
            Transition::ButtonDown(1),
            Transition::Other,
        ];

        assert_eq!(
            pending_releases(&accepted),
            [Transition::KeyUp(17), Transition::ButtonUp(1)]
        );
    }
}
