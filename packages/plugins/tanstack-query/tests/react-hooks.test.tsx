/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="@types/jest" />

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import nock from 'nock';
import React from 'react';
import { QUERY_KEY_PREFIX } from '../src/runtime/common';
import { RequestHandlerContext, useModelMutation, useModelQuery } from '../src/runtime/react';
import { modelMeta } from './test-model-meta';

describe('Tanstack Query React Hooks Test', () => {
    function createWrapper() {
        const queryClient = new QueryClient();
        const Provider = RequestHandlerContext.Provider;
        const wrapper = ({ children }: { children: React.ReactElement }) => (
            <QueryClientProvider client={queryClient}>
                {/* @ts-ignore */}
                <Provider value={{ logging: true }}>{children}</Provider>
            </QueryClientProvider>
        );
        return { queryClient, wrapper };
    }

    function makeUrl(model: string, operation: string, args?: unknown) {
        let r = `http://localhost/api/model/${model}/${operation}`;
        if (args) {
            r += `?q=${encodeURIComponent(JSON.stringify(args))}`;
        }
        return r;
    }

    beforeEach(() => {
        nock.cleanAll();
    });

    it('simple query', async () => {
        const { queryClient, wrapper } = createWrapper();

        const queryArgs = { where: { id: '1' } };
        const data = { id: '1', name: 'foo' };

        nock(makeUrl('User', 'findUnique', queryArgs)).get(/.*/).reply(200, {
            data,
        });

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findUnique'), queryArgs), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.isSuccess).toBe(true);
            expect(result.current.data).toMatchObject(data);
            const cacheData = queryClient.getQueryData([QUERY_KEY_PREFIX, 'User', 'findUnique', queryArgs]);
            expect(cacheData).toMatchObject(data);
        });
    });

    it('independent mutation and query', async () => {
        const { wrapper } = createWrapper();

        const queryArgs = { where: { id: '1' } };
        const data = { id: '1', name: 'foo' };

        let queryCount = 0;
        nock(makeUrl('User', 'findUnique', queryArgs))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                queryCount++;
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findUnique'), queryArgs), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toMatchObject({ name: 'foo' });
        });

        nock(makeUrl('Post', 'create'))
            .post(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                return { data: { id: '1', title: 'post1' } };
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('Post', 'POST', makeUrl('Post', 'create'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ data: { title: 'post1' } }));

        await waitFor(() => {
            // no refetch caused by invalidation
            expect(queryCount).toBe(1);
        });
    });

    it('create and invalidation', async () => {
        const { queryClient, wrapper } = createWrapper();

        const data: any[] = [];

        nock(makeUrl('User', 'findMany'))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findMany')), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toHaveLength(0);
        });

        nock(makeUrl('User', 'create'))
            .post(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data.push({ id: '1', name: 'foo' });
                return { data: data[0] };
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('User', 'POST', makeUrl('User', 'create'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ data: { name: 'foo' } }));

        await waitFor(() => {
            const cacheData = queryClient.getQueryData([QUERY_KEY_PREFIX, 'User', 'findMany', undefined]);
            expect(cacheData).toHaveLength(1);
        });
    });

    it('update and invalidation', async () => {
        const { queryClient, wrapper } = createWrapper();

        const queryArgs = { where: { id: '1' } };
        const data = { id: '1', name: 'foo' };

        nock(makeUrl('User', 'findUnique', queryArgs))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findUnique'), queryArgs), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toMatchObject({ name: 'foo' });
        });

        nock(makeUrl('User', 'update'))
            .put(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data.name = 'bar';
                return data;
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('User', 'PUT', makeUrl('User', 'update'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ ...queryArgs, data: { name: 'bar' } }));

        await waitFor(() => {
            const cacheData = queryClient.getQueryData([QUERY_KEY_PREFIX, 'User', 'findUnique', queryArgs]);
            expect(cacheData).toMatchObject({ name: 'bar' });
        });
    });

    it('top-level mutation and nested-read invalidation', async () => {
        const { queryClient, wrapper } = createWrapper();

        const queryArgs = { where: { id: '1' }, include: { posts: true } };
        const data = { posts: [{ id: '1', title: 'post1' }] };

        nock(makeUrl('User', 'findUnique', queryArgs))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findUnique'), queryArgs), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toMatchObject(data);
        });

        nock(makeUrl('Post', 'update'))
            .put(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data.posts[0].title = 'post2';
                return data;
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('Post', 'PUT', makeUrl('Post', 'update'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ where: { id: '1' }, data: { name: 'post2' } }));

        await waitFor(() => {
            const cacheData: any = queryClient.getQueryData([QUERY_KEY_PREFIX, 'User', 'findUnique', queryArgs]);
            expect(cacheData.posts[0].title).toBe('post2');
        });
    });

    it('top-level mutation and nested-count invalidation', async () => {
        const { queryClient, wrapper } = createWrapper();

        const queryArgs = { where: { id: '1' }, include: { _count: { select: { posts: true } } } };
        const data = { _count: { posts: 1 } };

        nock(makeUrl('User', 'findUnique', queryArgs))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('User', makeUrl('User', 'findUnique'), queryArgs), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toMatchObject(data);
        });

        nock(makeUrl('Post', 'create'))
            .post(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data._count.posts = 2;
                return data;
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('Post', 'POST', makeUrl('Post', 'create'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ data: { name: 'post2' } }));

        await waitFor(() => {
            const cacheData: any = queryClient.getQueryData([QUERY_KEY_PREFIX, 'User', 'findUnique', queryArgs]);
            expect(cacheData._count.posts).toBe(2);
        });
    });

    it('nested mutation and top-level-read invalidation', async () => {
        const { queryClient, wrapper } = createWrapper();

        const data = [{ id: '1', title: 'post1', ownerId: '1' }];

        nock(makeUrl('Post', 'findMany'))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('Post', makeUrl('Post', 'findMany')), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toMatchObject(data);
        });

        nock(makeUrl('User', 'update'))
            .put(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data.push({ id: '2', title: 'post2', ownerId: '1' });
                return data;
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('User', 'PUT', makeUrl('User', 'update'), modelMeta),
            {
                wrapper,
            }
        );

        act(() =>
            mutationResult.current.mutate({ where: { id: '1' }, data: { posts: { create: { title: 'post2' } } } })
        );

        await waitFor(() => {
            const cacheData: any = queryClient.getQueryData([QUERY_KEY_PREFIX, 'Post', 'findMany', undefined]);
            expect(cacheData).toHaveLength(2);
        });
    });

    it('cascaded delete', async () => {
        const { queryClient, wrapper } = createWrapper();

        const data: any[] = [{ id: '1', title: 'post1', ownerId: '1' }];

        nock(makeUrl('Post', 'findMany'))
            .get(/.*/)
            .reply(200, () => {
                console.log('Querying data:', JSON.stringify(data));
                return { data };
            })
            .persist();

        const { result } = renderHook(() => useModelQuery('Post', makeUrl('Post', 'findMany')), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.data).toHaveLength(1);
        });

        nock(makeUrl('User', 'delete'))
            .delete(/.*/)
            .reply(200, () => {
                console.log('Mutating data');
                data.pop();
                return { data: { id: '1' } };
            });

        const { result: mutationResult } = renderHook(
            () => useModelMutation('User', 'DELETE', makeUrl('User', 'delete'), modelMeta),
            {
                wrapper,
            }
        );

        act(() => mutationResult.current.mutate({ where: { id: '1' } }));

        await waitFor(() => {
            const cacheData = queryClient.getQueryData([QUERY_KEY_PREFIX, 'Post', 'findMany', undefined]);
            expect(cacheData).toHaveLength(0);
        });
    });
});
