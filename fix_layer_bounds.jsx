#target photoshop
app.bringToFront();

(function () {
    if (!app.documents.length) {
        alert("No document open.");
        return;
    }

    var doc = app.activeDocument;
    var targetNames = [
        "static_chad_eyebrow_left",
        "static_chad_eyebrow_right"
    ];

    function findLayerByName(parent, name) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i];
            if (layer.name === name) return layer;
            if (layer.typename === "LayerSet") {
                var found = findLayerByName(layer, name);
                if (found) return found;
            }
        }
        return null;
    }

    function expandLayerBounds(layer) {
        doc.activeLayer = layer;

        // Select full canvas
        doc.selection.selectAll();

        // Nudge right then left (no visual change, updates bounds)
        layer.translate(1, 0);
        layer.translate(-1, 0);

        // Deselect
        doc.selection.deselect();
    }

    for (var i = 0; i < targetNames.length; i++) {
        var layer = findLayerByName(doc, targetNames[i]);
        if (layer && layer.isBackgroundLayer === false) {
            expandLayerBounds(layer);
        } else {
            alert("Layer not found: " + targetNames[i]);
        }
    }

    alert("Eyebrow layers fixed ✔");
})();
