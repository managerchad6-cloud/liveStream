// renameStreamPSD.jsx
// Renames Stream PSD layers to match LiveStream export conventions

function findLayerByPath(layers, path) {
    var parts = path.split('/');
    var current = layers;

    for (var i = 0; i < parts.length; i++) {
        var found = false;
        for (var j = 0; j < current.length; j++) {
            if (current[j].name === parts[i]) {
                if (i === parts.length - 1) {
                    return current[j];
                } else if (current[j].typename === "LayerSet") {
                    current = current[j].layers;
                    found = true;
                    break;
                }
            }
        }
        if (!found) return null;
    }
    return null;
}

function renameStreamLayers() {
    if (!app.documents.length) {
        alert("No document open!");
        return;
    }

    var doc = app.activeDocument;
    var renamed = [];

    function doRename(path, newName) {
        var layer = findLayerByPath(doc.layers, path);
        if (layer) {
            renamed.push(layer.name + " -> " + newName);
            layer.name = newName;
        }
    }

    // ===== Mouths =====
    var chadMouth = {
        "A": "mouth_chad_A",
        "B": "mouth_chad_B",
        "C": "mouth_chad_C",
        "D": "mouth_chad_D",
        "E": "mouth_chad_E",
        "F": "mouth_chad_F",
        "G": "mouth_chad_G",
        "H": "mouth_chad_H",
        "Smile": "mouth_chad_smile",
        "Surprise": "mouth_chad_surprise"
    };

    var virginMouth = {
        "A": "mouth_virgin_A",
        "B": "mouth_virgin_B",
        "C": "mouth_virgin_C",
        "D": "mouth_virgin_D",
        "E": "mouth_virgin_E",
        "F": "mouth_virgin_F",
        "G": "mouth_virgin_G",
        "H": "mouth_virgin_H",
        "Smile": "mouth_virgin_smile",
        "Surprise": "mouth_virgin_surprise"
    };

    for (var key in chadMouth) {
        doRename("Characters/Chad/Chad Face/Mouth/" + key, chadMouth[key]);
    }
    for (var key2 in virginMouth) {
        doRename("Characters/Virgin/Virgin Face/Mouth/" + key2, virginMouth[key2]);
    }

    // ===== Blinks =====
    // Note: Chad "Blink " has trailing space in your tree
    doRename("Characters/Chad/Chad Face/Blink ", "blink_chad_closed");
    doRename("Characters/Virgin/Virgin Face/Blink", "blink_virgin_closed");

    // ===== Faces =====
    // Note: Chad "Face " has trailing space in your tree
    doRename("Characters/Chad/Chad Face/Face ", "static_chad_face");
    doRename("Characters/Virgin/Virgin Face/Face", "static_virgin_face");

    // ===== Eyes / Cover / Brows / Nose =====
    doRename("Characters/Chad/Chad Face/L Eye", "static_chad_eye_left");
    doRename("Characters/Chad/Chad Face/R Eye", "static_chad_eye_right");
    doRename("Characters/Chad/Chad Face/Eye Cover", "static_chad_eye_cover");

    doRename("Characters/Virgin/Virgin Face/L Eye", "static_virgin_eye_left");
    doRename("Characters/Virgin/Virgin Face/R Eye", "static_virgin_eye_right");
    doRename("Characters/Virgin/Virgin Face/Eye Cover", "static_virgin_eye_cover");
    doRename("Characters/Virgin/Virgin Face/L Eyebrow", "static_virgin_eyebrow_left");
    doRename("Characters/Virgin/Virgin Face/R Eyebrow", "static_virgin_eyebrow_right");
    doRename("Characters/Virgin/Virgin Face/Nose", "static_virgin_nose");

    // ===== Bodies / Chairs =====
    doRename("Characters/Chad/Chad Body", "static_chad_body");
    doRename("Characters/Chad/Chad Chair", "static_chad_chair");

    doRename("Characters/Virgin/Virgin Body", "static_virgin_body");
    doRename("Characters/Virgin/Virgin Chair", "static_virgin_chair");
    doRename("Characters/Virgin/Virgin Chair Layer 2", "static_virgin_chair_layer2");

    // ===== TV layers =====
    // Note: "Middleground " and "TV Reflection " have trailing spaces
    doRename("Middleground /TV/TV Reflection ", "TV_Reflection_");
    doRename("Middleground /TV/TV Mask", "mask");

    // Summary
    var message = "Renamed " + renamed.length + " layers:\n\n";
    for (var i = 0; i < Math.min(renamed.length, 25); i++) {
        message += renamed[i] + "\n";
    }
    if (renamed.length > 25) {
        message += "\n... and " + (renamed.length - 25) + " more";
    }
    alert(message);
}

renameStreamLayers();
