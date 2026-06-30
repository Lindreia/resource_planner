(function () {
    let pendingHref = null;

    function ensureDialog() {
        let dialog = document.getElementById("logoutConfirmDialog");
        if (dialog) return dialog;

        dialog = document.createElement("dialog");
        dialog.id = "logoutConfirmDialog";
        dialog.className = "logout-dialog";
        dialog.innerHTML =
            '<form method="dialog" class="logout-dialog-card">' +
            '<h3>Confirm Logout</h3>' +
            '<p>Do you want to log out now?</p>' +
            '<menu class="logout-dialog-actions">' +
            '<button value="cancel" class="logout-btn logout-btn-secondary">Cancel</button>' +
            '<button value="confirm" class="logout-btn logout-btn-primary">Logout</button>' +
            '</menu>' +
            '</form>';

        dialog.addEventListener("close", function () {
            if (dialog.returnValue === "confirm" && pendingHref) {
                window.location.href = pendingHref;
            }
            pendingHref = null;
        });

        document.body.appendChild(dialog);
        return dialog;
    }

    function bindLogoutLinks() {
        const links = document.querySelectorAll('a[href="/logout"], a.logout-link');
        if (!links.length) return;

        const dialog = ensureDialog();

        links.forEach(function (link) {
            link.classList.add("logout-link");
            link.addEventListener("click", function (event) {
                event.preventDefault();
                pendingHref = link.getAttribute("href") || "/logout";

                if (typeof dialog.showModal === "function") {
                    dialog.showModal();
                } else {
                    const ok = window.confirm("Do you want to log out now?");
                    if (ok && pendingHref) window.location.href = pendingHref;
                    pendingHref = null;
                }
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bindLogoutLinks);
    } else {
        bindLogoutLinks();
    }
})();
