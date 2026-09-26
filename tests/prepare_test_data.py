"""
Prepare the data the jsrr tests and page read over HTTP from the dev server, in ``data``:

    hydrography/region=<id>/routing.parquet                  a link to the region's routing parameters, read in place
    hydrography/region=<id>/gridweights_<grid>_<id>.parquet  the region's grid weights, converted from netCDF to parquet
    hydrography/<streams>.pmtiles                            a link to the streams the page's map draws, read in place
    runoff/<store>.zarr                                      a link to each runoff zarr store, read in place
    expected/region=<id>_<store>.json                        the hydrographs river-route routes for the test rivers,
                                                             and the runoff stores linked beside the routed one

river-route routes the expected hydrographs the way jsrr routes: static coefficients, the uniform transform, a standard
network, and a routing step equal to the runoff step. The region's main outlet, the one draining the largest area, is
always a test river, and --rivers adds others. Build the data with

    ../river-route/.venv/bin/python tests/prepare_test_data.py \
        --region-dir ~/data/v3TestData/hydrography/region=7020014250 \
        --runoff ~/data/era5_zarr_16x16_yearly/year=1940/era5_1940.zarr \
        --rivers 720184033

The page routes whichever region holds the river clicked on its map, from any runoff store beside the tests' one, so
--page-region-dirs, --more-runoff, and --streams add what it reads:

        --page-region-dirs ~/data/v3TestData/hydrography/region=* \
        --more-runoff ~/data/era5_zarr_16x16_yearly/year=194[1-9]/era5_194[1-9].zarr \
        --streams ~/data/v3TestData/hydrography/global/streams.pmtiles
"""

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

import river_route as rr

DATA = Path(__file__).parents[1] / 'data'


def grid_weights_to_parquet(netcdf: Path, parquet: Path) -> pd.DataFrame:
    """Write a grid weight table netCDF as parquet, row for row, with its cell indexes as int32 rather than int64."""
    with xr.open_dataset(netcdf) as ds:
        weights = ds.to_dataframe().reset_index(drop=True)
    weights = weights.astype({'x_index': np.int32, 'y_index': np.int32})
    weights.to_parquet(parquet, index=False, use_dictionary=False)
    return weights


def main_outlet(network: rr.Network, weights: pd.DataFrame) -> int:
    """The river id of the outlet that drains the largest area. Rivers come upstream first, so one pass sums areas."""
    area = weights.groupby('river_id')['area_sqm'].sum().reindex(network.river_ids).to_numpy(np.float64)
    downstream = network.downstream_indices
    for river in range(downstream.shape[0]):
        if downstream[river] >= 0:
            area[downstream[river]] += area[river]
    outlets = np.flatnonzero(downstream < 0)
    return int(network.river_ids[outlets[np.argmax(area[outlets])]])


def route_hydrographs(
    params: Path, weights: Path, runoff: Path, variable: str, river_ids: list[int], expected_dir: Path
) -> tuple[np.ndarray, np.ndarray]:
    """Route the runoff with river-route and keep the dates, as epoch seconds, and the discharge of ``river_ids``."""
    with xr.open_zarr(runoff) as ds:
        var_t, var_y, var_x = ds[variable].dims
    configs = rr.Configs(
        params_file=params,
        forcing='runoff',
        runoff_type='gaussian_grid',
        runoff_files=[runoff],
        grid_weights_file=weights,
        var_grid_runoff=variable,
        var_t=var_t,
        var_y=var_y,
        var_x=var_x,
        unstable_coefficients='ignore',
        discharge_files=[expected_dir / 'never_written.zarr'],
        log=False,
        progress_bar=False,
    )
    kept = {}

    def keep_test_rivers(router, dates, discharge_array, discharge_file, runoff_file=''):
        rows = pd.Index(router.network.river_ids).get_indexer(river_ids)
        if np.any(rows < 0):
            raise ValueError(f'rivers {np.asarray(river_ids)[rows < 0]} are not in {params}')
        kept['dates'] = dates.astype('datetime64[s]').astype(np.int64)
        kept['discharge'] = discharge_array[rows].copy()

    rr.Router(configs).set_discharge_writer(keep_test_rivers).route()
    return kept['dates'], kept['discharge']


def link(target: Path, path: Path) -> None:
    """Make ``path`` a symbolic link to ``target``, replacing an earlier link but never a real file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        path.unlink()
    path.symlink_to(target.resolve())


def serve_region(region_dir: Path) -> tuple[Path, Path, Path, pd.DataFrame]:
    """Link a region's routing parameters into ``data`` and write its grid weights there as parquet. Returns the served
    routing parameters, the grid weights netCDF and its served parquet, and the weights."""
    weights_netcdf = next(region_dir.glob('gridweights_*.nc'))
    served_region = DATA / 'hydrography' / region_dir.name
    served_params = served_region / 'routing.parquet'
    served_weights = served_region / f'{weights_netcdf.stem}.parquet'
    link(region_dir / 'routing.parquet', served_params)
    return served_params, weights_netcdf, served_weights, grid_weights_to_parquet(weights_netcdf, served_weights)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--region-dir', type=Path, required=True, help='hydrography folder with routing.parquet')
    parser.add_argument('--runoff', type=Path, required=True, help='gridded runoff zarr store')
    parser.add_argument('--variable', default='ro', help='runoff variable in the zarr store')
    parser.add_argument('--rivers', type=int, nargs='*', default=[], help='test rivers besides the main outlet')
    parser.add_argument('--page-region-dirs', type=Path, nargs='*', default=[], help='more regions for the page')
    parser.add_argument('--more-runoff', type=Path, nargs='*', default=[], help='more runoff stores for the page')
    parser.add_argument('--streams', type=Path, help="PMTiles of the streams the page's map draws")
    args = parser.parse_args()

    region_dir, runoff = args.region_dir.expanduser(), args.runoff.expanduser()
    more_runoff = [path.expanduser() for path in args.more_runoff]
    served_runoff = DATA / 'runoff' / runoff.name
    expected_dir = DATA / 'expected'
    expected_dir.mkdir(parents=True, exist_ok=True)

    for page_region_dir in {path.expanduser().resolve() for path in args.page_region_dirs} - {region_dir.resolve()}:
        serve_region(page_region_dir)
    for store in [runoff, *more_runoff]:
        link(store, DATA / 'runoff' / store.name)
    if args.streams is not None:
        link(args.streams.expanduser(), DATA / 'hydrography' / args.streams.name)
    served_params, weights_netcdf, served_weights, weights = serve_region(region_dir)
    outlet = main_outlet(rr.Network(served_params), weights)
    river_ids = [outlet, *[river for river in args.rivers if river != outlet]]
    dates, discharge = route_hydrographs(
        served_params, weights_netcdf, served_runoff, args.variable, river_ids, expected_dir
    )

    expected = {
        'description': f'{region_dir.name} routed with {runoff.name} by river-route',
        'built': {'date': datetime.now().isoformat(timespec='seconds'), 'river_route': rr.__version__},
        'routing_parameters': served_params.relative_to(DATA).as_posix(),
        'grid_weights': served_weights.relative_to(DATA).as_posix(),
        'runoff': f'{served_runoff.relative_to(DATA).as_posix()}/{args.variable}',
        'more_runoff': [f'runoff/{store.name}/{args.variable}' for store in more_runoff],
        'outlet_river_id': outlet,
        'dates': dates.tolist(),
        'hydrographs': {
            str(river): series.astype(np.float64).tolist() for river, series in zip(river_ids, discharge, strict=True)
        },
    }
    expected_file = expected_dir / f'{region_dir.name}_{Path(runoff.name).stem}.json'
    expected_file.write_text(json.dumps(expected))
    print(f'wrote {expected_file} with the hydrographs of rivers {river_ids}')


if __name__ == '__main__':
    main()
