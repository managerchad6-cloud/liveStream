#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Inspect PSD file and print layer tree structure.
Requires: pip install psd-tools
"""

import sys
import os
from pathlib import Path

# Fix Windows console encoding
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

try:
    from psd_tools import PSDImage
except ImportError:
    print("Error: psd-tools not installed. Install with: pip install psd-tools")
    sys.exit(1)

def print_layer_tree(layer, indent=0, prefix=""):
    """Recursively print layer tree with indentation."""
    indent_str = "  " * indent
    
    # Check if it's a group/layer
    is_group = False
    if hasattr(layer, 'is_group'):
        is_group = layer.is_group()
    elif hasattr(layer, 'kind') and layer.kind == 'group':
        is_group = True
    
    layer_type = "Group" if is_group else "Layer"
    
    # Get visibility
    visible = "[V]"
    if hasattr(layer, 'visible'):
        visible = "[V]" if layer.visible else "[H]"
    elif hasattr(layer, 'is_visible'):
        visible = "[V]" if layer.is_visible() else "[H]"
    
    # Get layer name
    name = "Unknown"
    if hasattr(layer, 'name'):
        name = layer.name
    elif hasattr(layer, 'tag'):
        name = str(layer.tag)
    
    # Print layer name only
    print(f"{indent_str}{prefix}{name}")
    
    # Recursively print children
    children = None
    if is_group:
        if hasattr(layer, 'layers'):
            children = layer.layers
        elif hasattr(layer, 'children'):
            children = layer.children
        elif hasattr(layer, '__iter__'):
            # Try iterating directly
            children = layer
    
    if children:
        try:
            child_list = list(children) if hasattr(children, '__iter__') and not isinstance(children, (str, bytes)) else [children]
            if child_list:
                for i, child in enumerate(child_list):
                    is_last = (i == len(child_list) - 1)
                    # Adjust prefix for nested items
                    if indent > 0:
                        parent_prefix = "    " if prefix.startswith("`") else "|   "
                    else:
                        parent_prefix = ""
                    child_prefix = parent_prefix + ("`-- " if is_last else "|-- ")
                    print_layer_tree(child, indent + 1, child_prefix)
        except Exception as e:
            # If iteration fails, just note it
            print(f"{indent_str}    (Could not list children: {e})")

def main():
    # Find PSD file
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    psd_path = project_root / "Stream.psd"
    
    if not psd_path.exists():
        print(f"Error: Stream.psd not found at {psd_path}")
        print("Please ensure Stream.psd exists in the project root.")
        sys.exit(1)
    
    print(f"Reading PSD file: {psd_path}")
    print(f"File size: {psd_path.stat().st_size / 1024 / 1024:.2f} MB")
    print("=" * 80)
    print()
    
    try:
        psd = PSDImage.open(psd_path)
        
        # Print document info
        print("Layer Tree (names only):")
        print("=" * 80)
        print()
        
        # Print root layers - try different access methods
        layers = None
        if hasattr(psd, 'layers'):
            layers = psd.layers
        elif hasattr(psd, 'layer_and_mask'):
            if hasattr(psd.layer_and_mask, 'layers'):
                layers = psd.layer_and_mask.layers
        elif hasattr(psd, '_layers'):
            layers = psd._layers
        
        if layers:
            layer_list = list(layers) if hasattr(layers, '__iter__') else [layers]
            for i, layer in enumerate(layer_list):
                is_last = (i == len(layer_list) - 1)
                prefix = "`-- " if is_last else "|-- "
                print_layer_tree(layer, 0, prefix)
        else:
            print("No layers found. Available attributes:")
            print(f"  PSD attributes: {[a for a in dir(psd) if not a.startswith('_')]}")
            if hasattr(psd, 'layer_and_mask'):
                print(f"  layer_and_mask attributes: {[a for a in dir(psd.layer_and_mask) if not a.startswith('_')]}")
        
        print()
        print("=" * 80)
        print("Layer tree printed above. You can copy and paste it.")
        
    except Exception as e:
        print(f"Error reading PSD file: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
