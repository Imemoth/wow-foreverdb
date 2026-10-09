using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

// Detail rows link items to the sources that produce them, then those
// sources back to the same items. Following an existing entry in the
// history is navigation Back/Forward, NOT a new, deeper breadcrumb.
// Match stable entity identity; labels can change and unrelated sources
// may share a name or ID at different levels.
public static class SearchDetailHistory
{
    public static bool FollowLink(
        SearchResultItem target,
        ref SearchResultItem? current,
        Stack<SearchResultItem> back,
        Stack<SearchResultItem> forward)
    {
        ArgumentNullException.ThrowIfNull(target);

        if (current is not null &&
            SearchResultSelection.SameEntity(current, target))
        {
            // A -> B -> A -> B should never grow indefinitely.
            return false;
        }

        // Reaching any ancestor via a detail link is a Back action.
        // Its undone steps remain available through Forward.
        if (back.Any(previous =>
                SearchResultSelection.SameEntity(previous, target)))
        {
            do
            {
                StepBack(ref current, back, forward);
            }
            while (current is not null &&
                   !SearchResultSelection.SameEntity(current, target));

            return true;
        }

        // A user can also re-follow a link to an already undone page.
        // Treat it like Forward instead of creating another duplicate.
        if (forward.Any(next =>
                SearchResultSelection.SameEntity(next, target)))
        {
            do
            {
                StepForward(ref current, back, forward);
            }
            while (current is not null &&
                   !SearchResultSelection.SameEntity(current, target));

            return true;
        }

        if (current is not null)
        {
            back.Push(current);
        }

        forward.Clear();
        current = target;
        return true;
    }

    public static bool StepBack(
        ref SearchResultItem? current,
        Stack<SearchResultItem> back,
        Stack<SearchResultItem> forward)
    {
        if (back.Count == 0)
        {
            return false;
        }

        if (current is not null)
        {
            forward.Push(current);
        }

        current = back.Pop();
        return true;
    }

    public static bool StepForward(
        ref SearchResultItem? current,
        Stack<SearchResultItem> back,
        Stack<SearchResultItem> forward)
    {
        if (forward.Count == 0)
        {
            return false;
        }

        if (current is not null)
        {
            back.Push(current);
        }

        current = forward.Pop();
        return true;
    }
}
